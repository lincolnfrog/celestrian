// ClipNode — playback (the render phase; AudioNode::render states what a
// const pass may write). The render equation (timing.h) over a take's
// samples, per comp cell, with the seam fade; the same equation over a
// take's notes; the live tail (monitored input, MIDI play-through); and
// the signal path's last steps: pre-fx gate -> rack -> output stage.
// Audio thread throughout: no locks, no heap, no logging.

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>

#include "clip_node.h"
#include "graph_snapshot.h"
#include "timing.h"

namespace celestrian {

namespace {
/** timing::forEachContentRun with every content run cut again at the
 * comp's cell edges — the cells lie at `cell_off + k·cell_len` of the
 * inner position (ClipNode::compCells), a grid a lock-collapse slides
 * off the take's own zero. `body(i, run, at)` as there. Bounded and
 * allocation-free. */
template <typename Body>
void forEachCompRun(int64_t t, int n, int64_t origin,
                    const timing::TimeMap& map, int64_t fold,
                    int64_t cell_len, int64_t cell_off, Body&& body) {
  timing::forEachContentRun(
      t, n, origin, map, fold, /*cell_len=*/0,
      [&](int i, int run, const timing::InnerAt& at) {
        if (at.rest || cell_len <= 0) {
          body(i, run, at);
          return;
        }
        timing::InnerAt cur = at;
        while (run > 0) {
          const int64_t into = timing::posMod(cur.inner - cell_off, cell_len);
          const int step = (int)std::min<int64_t>(run, cell_len - into);
          body(i, step, cur);
          i += step;
          run -= step;
          cur.inner += step;
          cur.h += step;
        }
      });
}

bool gateShut(float g0, float g1) { return g0 <= 0.0f && g1 <= 0.0f; }
bool gateOpen(float g0, float g1) { return g0 >= 1.0f && g1 >= 1.0f; }
}  // namespace

bool ClipNode::isSilencedThisBlock(const ProcessContext& context) const {
  if (is_muted.load()) return true;  // mute wins over solo
  // AudioNode::is_soloed: with a solo lit, a leaf sounds iff it or an
  // ancestor is soloed — an index walk over the snapshot.
  return context.any_solo && !snapIsUnderSolo(*context.snap, context.self);
}

ClipNode::PlaybackFrame ClipNode::playbackFrame(
    const ProcessContext& context) const {
  PlaybackFrame frame;
  frame.map = activeTimeMap();
  if (!frame.map.active()) {
    frame.map = timing::TimeMap::single(0, duration_samples.load());
  }
  const int64_t shot = frame.map.period();
  frame.origin = origin_rt_.load();
  frame.fold = period_from_context_.load() && context.context_cycle > shot
                   ? context.context_cycle
                   : shot;
  return frame;
}

void ClipNode::publishPlayhead(const PlaybackFrame& frame, int64_t t) const {
  const int64_t shot = frame.map.period();
  if (shot <= 0) {
    playhead_pos.store(0.0);
    return;
  }
  const timing::InnerAt at =
      timing::innerAt(t, frame.origin, frame.map, frame.fold);
  playhead_pos.store(at.rest ? 0.0 : (double)at.h / (double)shot);
}

void ClipNode::ensureScratch(int n, bool pair) const {
  if ((int)fx_scratch_.size() < n) fx_scratch_.resize((size_t)n);
  if (pair && (int)fx_scratch2_.size() < n) fx_scratch2_.resize((size_t)n);
}

void ClipNode::render(float* const* output_channels, int num_output_channels,
                      const ProcessContext& context) const {
  jassert(context.snap != nullptr && context.island != nullptr);
  if (contentKind() == ContentKind::Midi) {
    renderMidi(output_channels, num_output_channels, context);
    return;
  }
  // One content load per render: compaction may swap the pointer under
  // a playing clip.
  const juce::AudioBuffer<float>& buffer = *content_.load();
  const int n = context.num_samples;

  // The gate (AudioNode::gateEndpoints), resolved ONCE per block whatever
  // renders below: the ramp follows a mute while nothing sounds, so
  // content or a monitored input that starts under a mute starts shut.
  // `user_shut` is the mute/solo half alone: silenced, the ramp landed
  // before this block.
  const float ramp_before = user_gate_;
  float gate_g0 = 1.0f, gate_g1 = 1.0f;
  gateEndpoints(context, !isSilencedThisBlock(context), gate_g0, gate_g1);
  const bool user_shut = ramp_before <= 0.0f && user_gate_ <= 0.0f;
  const bool gate_shut = gateShut(gate_g0, gate_g1);

  // Whether the content branch ran the rack this block. The live tail
  // runs only when it did not: the chain runs once per block (echo lines
  // and plugin state advance per run) and the monitored input joins once.
  bool content_rendered = false;
  if (context.is_playing && is_playing && !committed_this_block_.load()) {
    const PlaybackFrame frame = playbackFrame(context);
    // The buffer rests under a shut gate and in a rest handed down from
    // above (ProcessContext::content_silent) — the chain hears silence
    // and its tail rings. Live input is not content: it answers to the
    // gate alone, so a member of a resting group is still monitored.
    const bool content_off = gate_shut || context.content_silent;
    const bool monitoring = !gate_shut && monitorLive(context);
    if (frame.map.period() > 0 && !(content_off && !fxIsLive())) {
      const int64_t cap = buffer.getNumSamples();
      if (cap <= 0) return;  // nothing to index: `% cap` below
      const bool stereo_content = buffer.getNumChannels() >= 2;
      // scratch2 is also what a mono clip is promoted into: by a stereo
      // input pair under monitoring, or by the rack.
      ensureScratch(n, stereo_content || monitoring || fxIsLive());
      const int64_t base = content_base_.load();
      // The comp, read once per render: each run reads one buffer.
      CompView comp;
      if (take_[0].comp_n.load(std::memory_order_relaxed) > 0) {
        readCompView(comp);
      }
      const int64_t cell_len = comp.n > 0 ? comp.q : 0;
      const int64_t fade =
          seam_fades_enabled.load(std::memory_order_relaxed)
              ? seamFadeSamples(context.sample_rate)
              : 0;
      for (int c = 0; c < (stereo_content ? 2 : 1); ++c) {
        float* scratch = c == 0 ? fx_scratch_.data() : fx_scratch2_.data();
        if (content_off) {
          std::fill(scratch, scratch + n, 0.0f);
          continue;
        }
        forEachCompRun(
            context.master_pos, n, frame.origin, frame.map, frame.fold,
            cell_len, comp.off,
            [&](int i, int run, const timing::InnerAt& at) {
              if (at.rest) {  // a one-shot's rest: silence into the rack
                std::fill(scratch + i, scratch + i + run, 0.0f);
                return;
              }
              const RunSource src = runSource(buffer, c, at.inner, comp);
              for (int k = 0; k < run; ++k) {
                scratch[(size_t)(i + k)] =
                    src.data[(base + at.inner + k) % src.cap];
              }
            });
        // On the dry content: before monitoring, the gate and the rack.
        applySeamFades(scratch, c, buffer, comp, context.master_pos, n,
                       frame.origin, frame.map, frame.fold, fade);
      }
      bool stereo = stereo_content;
      if (monitoring) stereo = addMonitorInput(context, stereo);
      if (!gate_shut && !gateOpen(gate_g0, gate_g1)) {
        applyGate(gate_g0, gate_g1, stereo, n);
      }
      // The rack may promote a mono clip to stereo; an armed node hands
      // it the block's live MIDI.
      bool out_stereo = stereo;
      if (fxIsLive()) {
        out_stereo = fxProcess(fx_scratch_.data(), fx_scratch2_.data(), n,
                               stereo, liveMidiFor(context));
      }
      content_rendered = true;
      sumOutputStage(output_channels, num_output_channels, out_stereo, n);
    }
    publishPlayhead(frame, context.master_pos);
  }

  if (!content_rendered) {
    renderLiveTail(output_channels, num_output_channels, context, gate_g0,
                   gate_g1, user_shut);
  }
}

void ClipNode::renderLiveTail(float* const* output_channels,
                              int num_output_channels,
                              const ProcessContext& context, float gate_g0,
                              float gate_g1, bool user_shut) const {
  const bool monitoring = monitorLive(context);
  const bool midi_live = midi_armed.load() && context.live_midi != nullptr &&
                         fxChain()->hasEnabledInstrument();
  if (!(monitoring || midi_live)) return;
  // Play-through rests at once under a mute: its sound is the
  // instrument's, made downstream of the gate.
  if (midi_live && isSilencedThisBlock(context)) return;
  if (user_shut) return;  // the ramp has landed: nothing to fade
  const int n = context.num_samples;
  ensureScratch(n, /*pair=*/true);
  std::fill(fx_scratch_.begin(), fx_scratch_.begin() + n, 0.0f);
  std::fill(fx_scratch2_.begin(), fx_scratch2_.begin() + n, 0.0f);
  bool stereo = false;
  if (monitoring) {
    stereo = addMonitorInput(context, false);
    if (!gateOpen(gate_g0, gate_g1)) applyGate(gate_g0, gate_g1, stereo, n);
  }
  bool out_stereo = stereo;
  if (fxIsLive()) {
    // A pure play-through feeds mono silence: the chain promotes at the
    // instrument slot and the synth overwrites. The device-stop
    // sound-off (requestMidiSoundOff) rides this path: the pair on the
    // channels the live events used, ahead of this block's events.
    const juce::MidiBuffer* live = liveMidiFor(context);
    if (live != nullptr) {
      for (const auto metadata : *live) {
        if (metadata.numBytes > 0) markChannelInUse(metadata.data[0]);
      }
    }
    const bool sound_off = midi_sound_off_due_ && midi_channels_in_use_ != 0;
    midi_sound_off_due_ = false;
    if (sound_off) {
      render_midi_.clear();
      addSoundOff(render_midi_, midi_channels_in_use_, 0);
      midi_channels_in_use_ = 0;
      if (live != nullptr) render_midi_.addEvents(*live, 0, n, 0);
      live = &render_midi_;
    }
    out_stereo =
        fxProcess(fx_scratch_.data(), fx_scratch2_.data(), n, stereo, live);
  }
  sumOutputStage(output_channels, num_output_channels, out_stereo, n);
}

bool ClipNode::addMonitorInput(const ProcessContext& context,
                               bool stereo) const {
  const int n = context.num_samples;
  const RingSpan span =
      ringSpan(context.input_clock, n, context.prerecord_ring_len);
  const int channels = context.prerecord_ring_channels;
  // A stereo pair when a right input is assigned, else the one input,
  // centered.
  const bool pair = isStereoInput();
  auto add = [&](int side, float* scratch) {
    const float* ring = context.prerecord_ring[inputFor(side, channels)];
    juce::FloatVectorOperations::add(scratch, ring + span.idx, span.first);
    if (n > span.first) {
      juce::FloatVectorOperations::add(scratch + span.first, ring,
                                       n - span.first);
    }
  };
  if (pair && !stereo) {
    std::fill(fx_scratch2_.begin(), fx_scratch2_.begin() + n, 0.0f);
    stereo = true;
  }
  add(0, fx_scratch_.data());
  if (stereo) add(pair ? 1 : 0, fx_scratch2_.data());
  return stereo;
}

void ClipNode::applyGate(float g0, float g1, bool stereo, int n) const {
  const float dg = (g1 - g0) / (float)std::max(1, n);
  for (int c = 0; c < (stereo ? 2 : 1); ++c) {
    float* scratch = c == 0 ? fx_scratch_.data() : fx_scratch2_.data();
    float g = g0;
    for (int i = 0; i < n; ++i, g += dg) scratch[(size_t)i] *= g;
  }
}

void ClipNode::sumOutputStage(float* const* output_channels,
                              int num_output_channels, bool stereo,
                              int n) const {
  celestrian::sumOutputStage(output_channels, num_output_channels,
                             fx_scratch_.data(),
                             stereo ? fx_scratch2_.data() : nullptr, n,
                             pan.load(), gain.load());
}

void ClipNode::readCompView(CompView& v) const {
  take_lock_.read([&](int slot) {
    const TakeTableCopy& c = take_[slot];
    v.n = c.comp_n.load(std::memory_order_relaxed);
    v.q = c.comp_q.load(std::memory_order_relaxed);
    v.off = c.comp_off.load(std::memory_order_relaxed);
    v.count = c.count.load(std::memory_order_relaxed);
    v.active = active_take_.load(std::memory_order_relaxed);
    for (int i = 0; i < kMaxCompCells; ++i) {
      v.cells[i] = c.comp_cells[i].load(std::memory_order_relaxed);
    }
    for (int i = 0; i < kMaxTakes; ++i) {
      v.buffers[i] = c.buffers[i].load(std::memory_order_relaxed);
      v.recorded[i] = c.recorded[i].load(std::memory_order_relaxed);
    }
  });
  if (v.n < 0 || v.n > kMaxCompCells) v.n = 0;
  if (v.count < 0 || v.count > kMaxTakes) v.count = 0;
}

ClipNode::RunSource ClipNode::runSource(const juce::AudioBuffer<float>& active,
                                        int c, int64_t inner,
                                        const CompView& comp) const {
  // [lo, hi): the take's own content [base, base + duration), and only
  // what was recorded of it — never a padded take's tail, the unwritten
  // head of a new take in a collapsed slot, or the reservation past the
  // write head.
  const int64_t base = content_base_.load();
  const int64_t end = base + duration_samples.load();
  if (comp.n > 0 && comp.q > 0 && inner >= comp.off) {
    const int64_t cell = (inner - comp.off) / comp.q;
    const int pick = cell < comp.n ? comp.cells[cell] : -1;
    if (pick >= 0 && pick < comp.count && pick != comp.active &&
        comp.buffers[pick] != nullptr &&
        comp.buffers[pick]->getNumSamples() > 0) {
      const juce::AudioBuffer<float>& tb = *comp.buffers[pick];
      const int64_t cap = tb.getNumSamples();
      return {tb.getReadPointer(std::min(c, tb.getNumChannels() - 1)), cap,
              base, std::min({cap, comp.recorded[pick], end})};
    }
  }
  const int64_t cap = active.getNumSamples();
  return {active.getReadPointer(c), cap, base,
          std::min({cap, write_position.load(), end})};
}

void ClipNode::applySeamFades(float* scratch, int c,
                              const juce::AudioBuffer<float>& active,
                              const CompView& comp, int64_t t, int n,
                              int64_t origin, const timing::TimeMap& map,
                              int64_t fold, int64_t fade) const {
  // Seams sit a segment, a cell or the rest apart at the least; half
  // that bounds the fade, so no two seams' windows ever overlap and
  // each window blends the plain reads the render just made. A comp
  // slid off the take's zero leaves a part cell at either end.
  const int64_t shot = map.period();
  const int64_t cell_len = comp.n > 0 ? comp.q : 0;
  int64_t F = fade;
  for (int s = 0; s < map.n; ++s) {
    F = std::min(F, (map.segs[s].end - map.segs[s].start) / 2);
  }
  if (fold > shot) F = std::min(F, (fold - shot) / 2);
  if (cell_len > 0) {
    F = std::min(F, cell_len / 2);
    if (const int64_t part = timing::posMod(comp.off, cell_len); part > 0) {
      F = std::min(F, std::min(part, cell_len - part) / 2);
    }
  }
  if (F < 2) return;

  // One side of a seam: the raw sample at its edge, or silence (a rest).
  struct Edge {
    RunSource src;
    int64_t idx = 0;
    bool silent = true;
  };
  const int64_t base = content_base_.load();
  Edge out;
  bool have_out = false;
  // Walk [t − F, t + n + F): every seam whose window reaches the block.
  // Each run boundary is a candidate; a continuous one (the same
  // buffer, the next sample — cell edges, inner-adjacent segments) is
  // no seam at all.
  forEachCompRun(
      t - F, n + (int)(2 * F), origin, map, fold, cell_len, comp.off,
      [&](int i, int run, const timing::InnerAt& at) {
        Edge in;
        if (!at.rest) {
          in.src = runSource(active, c, at.inner, comp);
          in.idx = base + at.inner;
          in.silent = false;
        }
        const bool seam =
            have_out &&
            (out.silent ? !in.silent
                        : in.silent || in.src.data != out.src.data ||
                              in.idx != out.idx + 1);
        if (seam) {
          const int64_t k0 = (int64_t)i - F;  // the seam's block offset
          auto blend = [&](int64_t k, float keep, float add) {
            if (k >= 0 && k < n) scratch[k] = keep * scratch[k] + add;
          };
          if (out.silent || out.idx + F < out.src.hi) {
            // The outgoing material runs on past the seam (its recorded
            // tail, or silence): cross it into the incoming AFTER the
            // seam, so the incoming lands on time and the outgoing
            // ends where it was cut.
            for (int64_t j = 0; j < F; ++j) {
              const float w = fadeRamp(j, F);
              const float tail =
                  out.silent ? 0.0f : out.src.data[out.idx + 1 + j];
              blend(k0 + j, w, (1.0f - w) * tail);
            }
          } else if (in.silent ||
                     (in.idx - F >= in.src.lo && in.idx < in.src.hi)) {
            // No tail, but the incoming has a lead-in: cross into it
            // BEFORE the seam, arriving at the incoming's first sample.
            for (int64_t j = 0; j < F; ++j) {
              const float w = fadeRamp(j, F);
              const float lead =
                  in.silent ? 0.0f : in.src.data[in.idx - F + j];
              blend(k0 - F + j, 1.0f - w, w * lead);
            }
          } else {
            // Neither side extends (a fresh loop's wrap — its take is
            // exactly the loop): out and in through a brief dip.
            const int64_t h = F / 2;
            for (int64_t j = 0; j < h; ++j) {
              const float w = fadeRamp(j, h);
              blend(k0 - h + j, 1.0f - w, 0.0f);
              blend(k0 + j, w, 0.0f);
            }
          }
        }
        out = in;
        if (!in.silent) out.idx = in.idx + run - 1;
        have_out = true;
      });
}

void ClipNode::renderMidi(float* const* output_channels,
                          int num_output_channels,
                          const ProcessContext& context) const {
  // How long the chain runs on after the last event, so the
  // instrument's envelopes and the effects after it ring out.
  constexpr double kTailSeconds = 4.0;
  const MidiSequence& seq = *midi_.load();
  const int n = context.num_samples;
  if (n <= 0) return;
  render_midi_.clear();
  int events_added = 0;
  auto addEvent = [&](const juce::uint8* bytes, int size, int offset) {
    render_midi_.addEvent(bytes, size, offset);
    if (size > 0) markChannelInUse(bytes[0]);
    ++events_added;
  };

  // The gate, resolved first: its closing is a sound-off edge below, and
  // the same endpoints gate the output.
  float gate_g0 = 1.0f, gate_g1 = 1.0f;
  gateEndpoints(context, !isSilencedThisBlock(context), gate_g0, gate_g1);
  const bool gate_closed = gate_g1 <= 0.0f;

  // A CLOSING EDGE (vst3.md §8.3): the content's notes release, then
  // the sound-off pair goes to every channel in use — once per edge.
  bool sound_off_sent = false;
  auto closingEdge = [&](int offset) {
    render_held_.releaseInto(render_midi_, offset);
    if (sound_off_sent || midi_channels_in_use_ == 0) return;
    addSoundOff(render_midi_, midi_channels_in_use_, offset);
    midi_channels_in_use_ = 0;
    sound_off_sent = true;
    ++events_added;
  };

  // The device-stop request control latched is a closing edge at the
  // block's TOP: ahead of every note this block strikes.
  if (midi_sound_off_due_) {
    midi_sound_off_due_ = false;
    closingEdge(0);
  }

  // CONTENT: the render equation over the note sequence. Each run covers
  // storage positions [p0, p0 + run) and its events land at block offset
  // i + (pos − p0). A DISCONTINUITY in what is covered releases the notes
  // the content had sounding (vst3.md §8.3: hanging notes close at the
  // seam) and nothing else: a loop or map seam, and a REST — the clip's
  // own between firings, or a resting group's handed down
  // (ProcessContext::resting). Content handed down silent with no rest
  // (a bounce tail) has STOPPED: a closing edge.
  const bool stopped = context.content_silent && !context.resting;
  const auto rest = [&](int offset) {
    if (midi_render_next_pos_ < 0) return;
    render_held_.releaseInto(render_midi_, offset);
    midi_render_next_pos_ = -1;
  };
  bool content_active = false;
  if (context.is_playing && is_playing && !committed_this_block_.load() &&
      !stopped) {
    const PlaybackFrame frame = playbackFrame(context);
    if (frame.map.period() > 0) {
      content_active = true;
      const int64_t base = content_base_.load();
      if (context.resting) {
        rest(0);
      } else {
        timing::forEachContentRun(
            context.master_pos, n, frame.origin, frame.map, frame.fold,
            /*cell_len=*/0, [&](int i, int run, const timing::InnerAt& at) {
              if (at.rest) {
                rest(i);
                return;
              }
              const int64_t p0 = base + at.inner;
              if (midi_render_next_pos_ != p0) {
                render_held_.releaseInto(render_midi_, i);
              }
              for (int k = seq.lowerBound(p0);
                   k < seq.count() && seq[k].pos < p0 + run; ++k) {
                if (events_added >= kMaxBlockEvents) break;
                const MidiEvent& e = seq[k];
                addEvent(e.bytes, e.size, i + (int)(e.pos - p0));
                render_held_.track(e.bytes, e.size);
              }
              midi_render_next_pos_ = p0 + run;
            });
      }
    }
    publishPlayhead(frame, context.master_pos);
  }
  if (!content_active && midi_content_was_active_) {
    closingEdge(0);
    midi_render_next_pos_ = -1;
  }
  midi_content_was_active_ = content_active;
  // The gate landing shut is a closing edge, placed where the ramp
  // reaches zero: the instrument falls silent under a closed gate, and
  // the content keeps feeding it meanwhile, so an unmute resumes
  // mid-phrase.
  if (gate_closed && !midi_gate_was_closed_) {
    closingEdge(gate_g0 > 0.0f ? n - 1 : 0);
  }
  midi_gate_was_closed_ = gate_closed;

  // LIVE PLAY-THROUGH: the armed node's events at their block offsets.
  // Not tracked in render_held_: the player's fingers own those
  // releases.
  if (midi_armed.load() && context.live_midi != nullptr) {
    for (const auto metadata : *context.live_midi) {
      if (events_added >= kMaxBlockEvents) break;
      addEvent(metadata.data, metadata.numBytes,
               std::clamp(metadata.samplePosition, 0, n - 1));
    }
  }

  // ONE chain run over silence, from the instrument down, while
  // something sounds or its release tail lasts.
  if (content_active || events_added > 0) {
    midi_tail_samples_left_ = (int64_t)(context.sample_rate * kTailSeconds);
  }
  if (!fxChain()->hasEnabledInstrument()) return;  // nothing generates
  if (midi_tail_samples_left_ <= 0) return;
  midi_tail_samples_left_ -= n;

  ensureScratch(n, /*pair=*/true);
  std::fill(fx_scratch_.begin(), fx_scratch_.begin() + n, 0.0f);
  std::fill(fx_scratch2_.begin(), fx_scratch2_.begin() + n, 0.0f);
  // Mono silence in; the chain promotes at the instrument slot and the
  // synth overwrites: stereo out.
  fxProcess(fx_scratch_.data(), fx_scratch2_.data(), n, /*stereo_in=*/false,
            &render_midi_);

  // A MIDI clip's gate sits on the instrument's OUTPUT: a silenced clip
  // still feeds its instrument, so nothing hangs.
  if (gateShut(gate_g0, gate_g1)) return;
  if (!gateOpen(gate_g0, gate_g1)) {
    applyGate(gate_g0, gate_g1, /*stereo=*/true, n);
  }
  sumOutputStage(output_channels, num_output_channels, /*stereo=*/true, n);
}

}  // namespace celestrian
