#include "clip_node.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>

#include "graph_snapshot.h"
#include "rt_log.h"
#include "timing.h"

namespace celestrian {

ClipNode::ClipNode(juce::String node_name, double source_sample_rate)
    : AudioNode(std::move(node_name)), sample_rate(source_sample_rate) {
  // Baseline: one second. The real capacity arrives at ARM as a huge
  // virtual reservation (see the D4 block in the header) and returns
  // to exact size at post-commit compaction — idle clips cost nothing.
  // Floor of 1: a zero-size buffer would make render's `% cap` a SIGFPE
  // (the engine can construct clips before a device reports its rate).
  content_owned_ = std::make_unique<juce::AudioBuffer<float>>(
      1, std::max(1, (int)sample_rate));
  content_owned_->clear();
  content_.store(content_owned_.get());
  fx_scratch_.resize(4096, 0.0f);  // typical max device block
  fx_scratch2_.resize(4096, 0.0f);
}

juce::var ClipNode::getMetadata() const {
  auto base = AudioNode::getMetadata();
  auto* obj = base.getDynamicObject();
  obj->setProperty("sampleRate", sample_rate);
  obj->setProperty("inputChannel", preferred_input_channel);
  obj->setProperty("inputChannelR", preferred_input_channel_right);
  // 2 when the content is stereo, or the next take will be (stereo
  // inputs assigned): the UI badges the lane either way.
  obj->setProperty("channels",
                   contentChannels() >= 2 || isStereoInput() ? 2 : 1);
  obj->setProperty("isPendingStart", isPendingStart());
  obj->setProperty("isAwaitingStop", isAwaitingStop());
  // The take's heard frame (Q14 take-marking modulus); 0 = first take.
  obj->setProperty("contextCycle", (double)take_context_cycle_.load());
  obj->setProperty("isPlaying", (bool)is_playing.load());

  // (recordingStartPhase was deleted 2026-07-16: no consumer existed —
  // the take's landing phase is a projection of `origin`.)
  return base;
}

int64_t ClipNode::getEffectiveQuantum() const {
  if (auto* p = parent.load()) return p->getEffectiveQuantum();
  return 0;
}

void ClipNode::control(const float* const* input_channels,
                       int num_input_channels, const ProcessContext& context) {
  // A new block: last block's commit (if any) has been rendered-silent
  // once; playback proceeds from this block on.
  committed_this_block_.store(false);

  // === Armed: choose/reach the arm target (state machine, kernel.md §3;
  // re-evaluated every block — deliberate: the latency-compensated clock
  // must be able to land back on a boundary the raw clock already
  // passed). May transition to Capturing within this block.
  if (recState() == RecState::Armed) {
    armEvaluate(context);
  }

  // === Stop request → PendingStop. The boundary is computed HERE, on
  // the audio thread, from the audio thread's own write position — the
  // old message-thread computation raced the recorder and could pick a
  // boundary already behind the write head (unification_audit.md D2).
  if (recState() == RecState::Capturing && stop_requested_.load()) {
    // Island Q rides the context (Tier 3 Step 3 — no audio-thread parent
    // walks); the walk survives only as the node-level unit-test
    // fallback (single-threaded, race-free by construction).
    const int64_t Q =
        context.quantum > 0 ? context.quantum : getEffectiveQuantum();
    if (Q > 0) {
      int64_t boundary = timing::nextStopBoundary(write_position.load(), Q);
      // Through-map: one map pass is the hard ceiling (ruling 2) — a
      // stop in the final stretch clamps to the period itself.
      if (through_map_capture_) {
        boundary = std::min(boundary, take_map_.period());
      }
      awaiting_stop_at.store(boundary);
      rec_state_.store((int)RecState::PendingStop);
      RtLog::instance().post("ClipNode: PendingStop at B=%lld (L=%lld)",
                             (long long)boundary,
                             (long long)write_position.load());
    }
    stop_requested_.store(false);
  }

  // Handle Recording (Capturing or PendingStop)
  if (isRecording()) {
    // ONE content load per control pass (the message thread swaps this
    // pointer only for idle clips, never mid-capture).
    juce::AudioBuffer<float>& buffer = *content_.load();

    // D4 wall guard — integrity, not policy: the arm-time reservation
    // is ~hours, but IF capture ever nears it, finish CLEANLY at the
    // last boundary that fits instead of silently dropping audio.
    if (recState() == RecState::Capturing && !stop_requested_.load()) {
      const int64_t cap = buffer.getNumSamples();
      const int64_t wp = write_position.load();
      const int64_t Q =
          context.quantum > 0 ? context.quantum : getEffectiveQuantum();
      if (Q > 0) {
        if (cap - wp <= Q + 8192) {  // next boundary must still fit
          stop_requested_.store(true);
          cap_hit_.store(true);
          RtLog::instance().post(
              "ClipNode: take reached the reservation bound — finishing "
              "at the last clean boundary");
        }
      } else if (cap - wp <= context.num_samples) {
        // Pre-Q first take: commit at the wall (duration = written).
        commit_master_pos.store(context.master_pos);
        cap_hit_.store(true);
        RtLog::instance().post(
            "ClipNode: first take reached the reservation bound — "
            "committed at %lld samples",
            (long long)wp);
        commitRecording(-1, &context);
        return;
      }
    }
    if (context.is_recording && capture_uses_ring_ &&
        context.prerecord_ring != nullptr &&
        context.prerecord_ring_channels > 0) {
      // Arrival-time capture (docs/performance.md §3): copy from the
      // engine's pre-record ring the samples whose arrival times the clip
      // covers. The window start (capture_next_clock_) already encodes the
      // latency compensation, so a note played on the HEARD beat lands on
      // the beat in the clip — the live-block path below cannot do that,
      // because the note's audio arrives ~latency after the boundary.
      const int64_t available_end = context.input_clock + context.num_samples;
      int64_t src = capture_next_clock_;
      const int ring_len = context.prerecord_ring_len;
      const int64_t oldest = std::max<int64_t>(0, available_end - ring_len);
      if (src < oldest) {
        // Latched to ONE line per capture: a persistent underrun fires
        // every block, and per-block posts kept the drain FIFO
        // permanently full (the field hang's log storm — 860 posts/sec
        // across five armed clips).
        if (!underrun_logged_) {
          underrun_logged_ = true;
          RtLog::instance().post(
              "ClipNode: pre-record ring underrun, %lld samples lost",
              (long long)(oldest - src));
        }
        src = oldest;
      }

      if (src < available_end) {
        const int wp = write_position.load();
        int64_t space = buffer.getNumSamples() - wp;
        // One-period cap (through-map, ruling 2): heard length never
        // exceeds one map pass — no overdub by construction.
        if (through_map_capture_) {
          space = std::min(space, take_map_.period() - wp);
        }
        const int n = (int)std::min<int64_t>(available_end - src, space);
        if (n > 0) {
          const int idx = (int)(src % ring_len);
          const int first = std::min(n, ring_len - idx);
          // One content channel per assigned input (stereo pairs write
          // channel 0 ← L, channel 1 ← R; capture_channels_ was fixed
          // at arm alongside the buffer's channel count).
          const int ncap = std::min(capture_channels_, buffer.getNumChannels());
          float blockPeak = 0.0f;
          for (int c = 0; c < ncap; ++c) {
            // Clamp both ways: −1 is a first-class "no assignment"
            // value in the UI/session layer and must not index ring[−1].
            const int ch = std::clamp(c == 0 ? preferred_input_channel
                                             : preferred_input_channel_right,
                                      0, context.prerecord_ring_channels - 1);
            const float* ring = context.prerecord_ring[ch];
            captureWrite(buffer, c, wp, ring + idx, first);
            if (n > first) captureWrite(buffer, c, wp + first, ring, n - first);

            // Peak tracking over the captured region — iterate the
            // SOURCE (the through-map fold scatters destinations).
            for (int i = 0; i < first; ++i) {
              blockPeak = std::max(blockPeak, std::abs(ring[idx + i]));
            }
            for (int i = first; i < n; ++i) {
              blockPeak = std::max(blockPeak, std::abs(ring[i - first]));
            }
          }
          capture_next_clock_ = src + n;
          finishCaptureBlock(n, blockPeak, context);
        }
      }
    } else if (context.is_recording && input_channels != nullptr &&
               num_input_channels > 0) {
      int64_t space = buffer.getNumSamples() - write_position.load();
      // One-period cap (through-map, ruling 2) — see the ring path.
      if (through_map_capture_) {
        space = std::min(space, take_map_.period() - write_position.load());
      }
      const int samples_to_write =
          (int)std::min<int64_t>(context.num_samples, space);

      if (samples_to_write > 0) {
        const int ncap = std::min(capture_channels_, buffer.getNumChannels());
        // Peak tracking over the CAPTURED channels only — the meter
        // reports the take, not the device (owner ruling 2026-08-09b;
        // unified with the ring path, which always did this).
        float blockPeak = 0.0f;
        for (int c = 0; c < ncap; ++c) {
          const float* in = input_channels[std::clamp(
              c == 0 ? preferred_input_channel : preferred_input_channel_right,
              0, num_input_channels - 1)];
          if (in == nullptr) continue;  // device delivered a null channel
          captureWrite(buffer, c, write_position.load(), in, samples_to_write);
          for (int i = 0; i < samples_to_write; ++i) {
            blockPeak = std::max(blockPeak, std::abs(in[i]));
          }
        }
        finishCaptureBlock(samples_to_write, blockPeak, context);
        // Note: if samples_to_write <= 0, buffer is full - just stop
        // writing. Do NOT commit here; wait for explicit stop.
      }
    }
  }
}

void ClipNode::finishCaptureBlock(int written, float block_peak,
                                  const ProcessContext& context) {
  last_block_peak.store(block_peak);
  if (block_peak > current_max_peak.load()) {
    current_max_peak.store(block_peak);
  }

  const int64_t start_position = write_position.load();
  write_position.fetch_add(written);
  const int64_t end_position = write_position.load();
  live_duration_samples.store(end_position);  // Live update for UI

  if (recState() == RecState::PendingStop) {
    const int64_t target = awaiting_stop_at.load();
    if (start_position < target && end_position >= target) {
      commit_master_pos.store(context.master_pos);
      commitRecording(target, &context);
      return;
    }
  }
  // One-period cap wall: a full map pass auto-finishes CLEANLY (the D4
  // wall-guard discipline; the pass end IS a boundary).
  if (through_map_capture_ && end_position >= take_map_.period()) {
    commit_master_pos.store(context.master_pos);
    RtLog::instance().post(
        "ClipNode: through-map take completed one map period — "
        "committing");
    commitRecording(-1, &context);
  }
}

void ClipNode::captureWrite(juce::AudioBuffer<float>& buffer, int dest_ch,
                            int64_t heard_pos, const float* src, int n) {
  if (!through_map_capture_) {
    buffer.copyFrom(dest_ch, (int)heard_pos, src, n);
    return;
  }
  // THROUGH-MAP FOLD (time_maps.md §3): destinations follow the mapped
  // clock — content lands at the inner positions the performance was
  // heard against, folded into the dense [0, C) buffer. Each map seam
  // jumps the write cursor (bounded by the map's segment count per
  // pass; allocation-free). heard_pos < period by the one-period cap.
  const int64_t C = map_commit_cycle_.load();
  int64_t pos = heard_pos;
  while (n > 0) {
    const int64_t seam = take_map_.seamDistance(map_anchor_off_ + pos);
    const int run = (int)std::min<int64_t>(n, seam > 0 ? seam : n);
    const int64_t dest =
        timing::throughMapDest(pos, map_anchor_off_, take_map_, C);
    buffer.copyFrom(dest_ch, (int)dest, src, run);
    pos += run;
    src += run;
    n -= run;
  }
}

void ClipNode::render(float* const* output_channels, int num_output_channels,
                      const ProcessContext& context) const {
  // ONE content load per render (compaction may swap the pointer under
  // a playing clip; the retired buffer outlives this block).
  const juce::AudioBuffer<float>& buffer = *content_.load();
  // Whether the content branch ran the chain this block — the live
  // play-through tail below must never run it a SECOND time (echo
  // lines and plugin state advance per run).
  bool fx_pass_ran = false;
  // The kernel playback equation (§2.3 render phase): a pure function
  // of (buffer, origin, window, t). The commit block renders SILENT
  // (committed_this_block_) — identical to the historical process(),
  // which returned right after commit.
  if (context.is_playing && is_playing && !committed_this_block_.load()) {
    // The clip's map, fractal (I5): a multi-segment override, or the
    // loop region as the single-segment case. BYPASSED (or invalid)
    // maps fall back to the full take — commit sets [0, duration) on
    // every clip, so the un-mapped path is identical to the historical
    // behavior.
    timing::TimeMap map = activeTimeMap();
    if (!map.active()) {
      map = timing::TimeMap::single(0, duration_samples.load());
    }
    const int64_t dur = map.period();

    if (dur > 0) {
      bool isSilenced = is_muted.load() || context.any_solo;
      if (isSilenced && !is_muted.load()) {
        // Solo audibility (Q16 canon): with any solo lit anywhere in
        // the island, a leaf sounds iff it — or an ancestor — is
        // soloed (additive: every lit path sounds; fractal: a soloed
        // group covers its subtree). Index walk over the whole-graph
        // snapshot — the audio thread never chases parent pointers
        // (Tier 3 Step 3). The pointer walk survives only as the
        // unit-test fallback. Mute wins over solo (the container rule
        // pinned in output_stage_tests).
        if (context.snap) {
          isSilenced = !snapIsUnderSolo(*context.snap, context.self);
        } else {
          const celestrian::AudioNode* curr = this;
          while (curr != nullptr) {
            if (curr->is_soloed.load()) {
              isSilenced = false;
              break;
            }
            curr = curr->getParent();
          }
        }
      }

      // Audio Memory Principle — the kernel playback equation
      // (docs/kernel.md §2), generalized through the map (phase 3, the
      // ANCHORING LAW): clip map playback ≡ the stack map with
      // epoch := origin + mapOffset(0):
      //
      //   p(t) = mapOffset((t − origin − mapOffset(0)) mod period)
      //
      // The single-segment case p(t) = start + ((t − origin − start)
      // mod len) IS the 2026-07-19 `origin + loopStart` anchoring
      // (window content sounds at its OWN performed moment); the
      // un-mapped case reduces to (t − origin) mod dur, the historical
      // equation. Later segments shift earlier by the removed time —
      // punch semantics; groove-transparent when cuts are kQ (seam
      // theorem).
      const int64_t org = origin_samples.load();
      const int64_t a0 = map.mapOffset(0);

      if (!isSilenced) {
        // Render into the fx scratches (channel 0 → fx_scratch_,
        // channel 1 of stereo content → fx_scratch2_), run the rack,
        // then sum PANNED into the parent — effects shape THIS clip's
        // signal in isolation. Resize is a rare growth (same pattern as
        // StackNode's mix_buffer); constructor pre-reserves a typical
        // block.
        if ((int)fx_scratch_.size() < context.num_samples) {
          fx_scratch_.resize((size_t)context.num_samples);
        }
        // Content base (Q13 lock-collapse): the committed content may
        // start mid-buffer; content coordinates stay 0-based.
        const int64_t base = content_base_.load();
        const int64_t cap = buffer.getNumSamples();
        if (cap <= 0) return;  // degenerate buffer: `% cap` would SIGFPE
        const bool stereo = buffer.getNumChannels() >= 2;
        // scratch2 is also the PROMOTION target (Q-V1): a mono clip
        // with a live chain may come back stereo from the fx pass.
        if ((stereo || fxIsLive()) &&
            (int)fx_scratch2_.size() < context.num_samples) {
          fx_scratch2_.resize((size_t)context.num_samples);
        }
        // THE PERIOD-SOURCE KNOB (Q5): a one-shot's period is the
        // context cycle, so the phase folds on P = context_cycle and
        // content sounds only while the phase is inside [0, dur) — the
        // rest of the cycle renders honest SILENCE through the same
        // scratch (so the fx rack hears it and echo/reverb tails ring
        // out naturally after the shot). P == dur (knob off, or a
        // degenerate context no longer than the content) reduces to the
        // historical loop equation exactly.
        const int64_t cyc =
            period_from_context_.load() && context.context_cycle > dur
                ? context.context_cycle
                : dur;
        // Run-split at map seams (bounded, allocation-free — the stack
        // splitter's discipline inside the clip loop): each run is a
        // contiguous read.
        for (int c = 0; c < (stereo ? 2 : 1); ++c) {
          const float* data = buffer.getReadPointer(c);
          float* scratch = c == 0 ? fx_scratch_.data() : fx_scratch2_.data();
          int i = 0;
          while (i < context.num_samples) {
            int64_t h = (context.master_pos + i - org - a0) % cyc;
            h = (h + cyc) % cyc;
            if (h >= dur) {  // one-shot rest region
              const int run =
                  (int)std::min<int64_t>(context.num_samples - i, cyc - h);
              std::fill(scratch + i, scratch + i + run, 0.0f);
              i += run;
              continue;
            }
            const int run = (int)std::min<int64_t>(
                std::min<int64_t>(context.num_samples - i, dur - h),
                map.seamDistance(h));
            const int64_t p0 = map.mapOffset(h);
            for (int k = 0; k < run; ++k) {
              scratch[(size_t)(i + k)] = data[(base + p0 + k) % cap];
            }
            i += run;
          }
        }
        // fxIsLive: enabled slots OR an open panel watching the scope
        // (capture-only pass costs one copy; the chain no-ops). The fx
        // pass may PROMOTE a mono clip to stereo (Q-V1: first enabled
        // VST3 slot) — out_stereo carries the post-chain shape into
        // the output stage; pan is untouched by this (applied below,
        // per channel, after the chain — §3.3).
        bool out_stereo = stereo;
        if (fxIsLive()) {
          // Armed nodes hand the block's live MIDI to their chain
          // (phase 4) — an enabled instrument slot consumes it.
          out_stereo = fxProcess(fx_scratch_.data(), fx_scratch2_.data(),
                                 context.num_samples, stereo,
                                 liveMidiFor(context));
          fx_pass_ran = true;
        }
        // The output stage (unification_audit §2.4): gain·pan resolved
        // together, post-fx. Pan (balance law, audio_node.h): output
        // channel 0 is L, channel 1 is R. Mono content pans between
        // them (center is unity on both — the historical behavior);
        // stereo content treats pan as balance (attenuate the far
        // side). A mono OUTPUT hears the unpanned center at the fader
        // (channels ≥ 2, if any, likewise get the fader-scaled
        // unpanned mono sum). Mute short-circuited above (isSilenced),
        // so the fader here is just `gain`.
        float gl = 1.0f, gr = 1.0f, fader = 1.0f;
        outputStageGains(pan.load(), gain.load(), MuteState::AUDIBLE, gl, gr,
                         fader);
        for (int ch = 0; ch < num_output_channels; ++ch) {
          if (output_channels[ch] == nullptr) continue;
          const bool right = ch == 1 && num_output_channels >= 2;
          const float* src =
              out_stereo && right ? fx_scratch2_.data() : fx_scratch_.data();
          float g = fader;
          if (num_output_channels >= 2 && ch < 2) g = right ? gr : gl;
          if (out_stereo && num_output_channels < 2) {
            // Fold stereo content to a mono device: equal halves.
            if (fader <= 0.0f) continue;
            juce::FloatVectorOperations::addWithMultiply(
                output_channels[ch], fx_scratch_.data(), 0.5f * fader,
                context.num_samples);
            juce::FloatVectorOperations::addWithMultiply(
                output_channels[ch], fx_scratch2_.data(), 0.5f * fader,
                context.num_samples);
            continue;
          }
          if (g == 1.0f) {
            juce::FloatVectorOperations::add(output_channels[ch], src,
                                             context.num_samples);
          } else if (g > 0.0f) {
            juce::FloatVectorOperations::addWithMultiply(
                output_channels[ch], src, g, context.num_samples);
          }
        }
      }

      // Update playhead position for UI (0..1): the heard phase of the
      // map pass — identical to the launch-point form for single
      // segments. One-shots phase over their FULL period (the context
      // cycle), so the sweep is honest about the rest region.
      {
        const int64_t pp =
            period_from_context_.load() && context.context_cycle > dur
                ? context.context_cycle
                : dur;
        int64_t h = (context.master_pos - org - a0) % pp;
        h = (h + pp) % pp;
        playhead_pos.store((double)h / (double)pp);
      }
    } else {
      playhead_pos.store(0.0);
    }
  }

  // --- Live MIDI play-through (docs/vst3.md §8, phase 4) ---
  // The armed node's instrument sounds INDEPENDENT of transport and
  // content: when the content branch did not run the chain (stopped
  // transport, empty clip, pending take), render silence through it
  // with the live events so the synth speaks under the player's
  // hands. Muted / solo-silenced nodes stay quiet — the same
  // audibility rule content follows.
  if (!fx_pass_ran && midi_armed.load() && context.live_midi != nullptr &&
      fxChain()->hasEnabledInstrument()) {
    bool silenced = is_muted.load() || context.any_solo;
    if (silenced && !is_muted.load()) {
      if (context.snap) {
        silenced = !snapIsUnderSolo(*context.snap, context.self);
      } else {
        const celestrian::AudioNode* curr = this;
        while (curr != nullptr) {
          if (curr->is_soloed.load()) {
            silenced = false;
            break;
          }
          curr = curr->getParent();
        }
      }
    }
    if (!silenced) {
      if ((int)fx_scratch_.size() < context.num_samples)
        fx_scratch_.resize((size_t)context.num_samples);
      if ((int)fx_scratch2_.size() < context.num_samples)
        fx_scratch2_.resize((size_t)context.num_samples);
      std::fill(fx_scratch_.begin(),
                fx_scratch_.begin() + context.num_samples, 0.0f);
      std::fill(fx_scratch2_.begin(),
                fx_scratch2_.begin() + context.num_samples, 0.0f);
      // Mono silence in; the chain promotes at the instrument slot and
      // the synth overwrites — out_stereo is true by construction.
      fxProcess(fx_scratch_.data(), fx_scratch2_.data(), context.num_samples,
                /*stereo_in=*/false, context.live_midi);
      float gl = 1.0f, gr = 1.0f, fader = 1.0f;
      outputStageGains(pan.load(), gain.load(), MuteState::AUDIBLE, gl, gr,
                       fader);
      for (int ch = 0; ch < num_output_channels; ++ch) {
        if (output_channels[ch] == nullptr) continue;
        const bool right = ch == 1 && num_output_channels >= 2;
        const float* src = right ? fx_scratch2_.data() : fx_scratch_.data();
        const float g =
            num_output_channels >= 2 && ch < 2 ? (right ? gr : gl) : fader;
        if (g > 0.0f) {
          juce::FloatVectorOperations::addWithMultiply(
              output_channels[ch], src, g, context.num_samples);
        }
      }
    }
  }
}

void ClipNode::armEvaluate(const ProcessContext& context) {
  // Island facts ride the context (Tier 3 Step 3): quantum, invariant
  // epoch, and the island root itself — no audio-thread parent walks.
  // The walks survive only as the node-level unit-test fallback.
  const int64_t Q =
      context.quantum > 0 ? context.quantum : getEffectiveQuantum();
  celestrian::AudioNode* island = context.island ? context.island : rootNode();

  // Latency compensation: the performer plays against what they HEARD
  // (delayed by output latency); it reaches the software input latency
  // later. Total compensation = input + output (or the calibrated
  // round trip, which the engine substitutes for both).
  int64_t compensated_pos =
      context.master_pos - (context.input_latency + context.output_latency);
  if (compensated_pos < 0) compensated_pos = 0;

  if (Q <= 0) {
    // First clip: starts NOW. This arm moment IS the island epoch —
    // captured as data at the root (the clock is never reset,
    // kernel.md); commit stores Q + epoch together with the same value.
    origin_samples.store(compensated_pos);
    island->establishIsland(0, compensated_pos);
    beginCapture(context, compensated_pos, compensated_pos);
    RtLog::instance().post(
        "ClipNode: Recording Started at master_pos=%lld (first clip)",
        (long long)compensated_pos);
    return;
  }

  // === THROUGH-MAP ARM (time_maps.md phase 2): an enclosing ACTIVE
  // map shapes this take. Arm math runs in HEARD time on the map
  // period's grid (ruling 2: the map IS the context loop), anchored at
  // the heard grid anchor; the chosen boundary then maps to an
  // inner-time origin through m (§3 arm/anchor semantics). The trigger
  // clock is the INVARIANT island clock — the folded master_pos wraps
  // every map period and never crosses a target at/past the map's end.
  // The Q15 origin fold is SUBSUMED here: a through-map origin is
  // already an inner-time fact inside one map pass — there are no
  // audibly-equivalent intrinsic slots to choose among.
  if (map_commit_cycle_.load() > 0 && context.map.active()) {
    const int64_t period = context.map.period();
    int64_t heard =
        context.island_pos - (context.input_latency + context.output_latency);
    if (heard < 0) heard = 0;
    int64_t rel_h = heard - context.map_heard_epoch;
    if (rel_h < 0) rel_h = 0;

    const int64_t t_rel = timing::armTarget(rel_h, Q, period);
    const int64_t heard_target = context.map_heard_epoch + t_rel;
    // The anchor's inner position, absolute: segments select view
    // positions of the mapping node's received frame, whose cycle top
    // is map_heard_epoch (the one-frame rule, time_maps.md §2).
    const int64_t origin =
        context.map_heard_epoch + context.map.mapOffset(t_rel);

    origin_samples.store(origin);
    awaiting_start_at.store(heard_target);

    const bool reached =
        heard >= heard_target || heard_target - heard < 512 ||
        (context.island_pos < heard_target &&
         context.island_pos + context.num_samples >= heard_target);
    if (reached) {
      // Freeze the take's map facts before capture begins.
      take_map_ = context.map;
      map_anchor_off_ = ((t_rel % period) + period) % period;
      through_map_capture_ = true;
      beginCapture(context, heard_target, heard);
      RtLog::instance().post(
          "ClipNode: Through-map recording started (heard target %lld, "
          "inner origin %lld)",
          (long long)heard_target, (long long)origin);
    }
    return;
  }

  // ALL cycle-relative math happens in the ISLAND EPOCH frame — mixing
  // absolute-frame math with the epoch-rebased view was the field bug
  // "clip 3 anchored at 3Q instead of 0Q". The INVARIANT epoch rides
  // the context (cycle_epoch gets re-based by windowed stacks; this one
  // never is).
  const int64_t epoch =
      context.island ? context.island_epoch : getIslandEpoch();

  // Context loop = the loop the performer was listening to: longest
  // committed sibling, min Q — computed by the PARENT and passed down
  // (P1-6: leaves never inspect siblings).
  const int64_t context_loop = std::max(Q, context.context_loop);

  int64_t rel = compensated_pos - epoch;
  if (rel < 0) rel = 0;

  // THE canonical timing fact: this clip's content belongs at the arm
  // target — stored ABSOLUTE (docs/kernel.md). Anchor, launch point,
  // and lane x are all projections of this one value. Re-stored per
  // block while Armed; it converges to the chosen boundary.
  //
  // The target is the next Q boundary in the HEARD frame
  // (latency-compensated, epoch-relative): a click shortly before a
  // boundary compensates back ONTO it — "the pickup" (E-A) needs no
  // extra machinery. The old anticipatory-window DEFERRAL is deleted
  // (field bug 2026-07-16): it added nothing — any click before a
  // boundary already targets that boundary — and when the compensation
  // was small it skipped past the boundary and overshot the take to
  // the NEXT one (clip armed before 2Q anchored at 3Q).
  const int64_t target = epoch + timing::armTarget(rel, Q, context_loop);

  // HEARD-FRAME ORIGIN FOLD (Q15, field 2026-07-16e): when active
  // windows make the audible cycle SHORTER than the intrinsic one, the
  // heard world is exactly heard-cycle-periodic — so every boundary in
  // {target − k·heard} is AUDIBLY IDENTICAL as an anchor, differing
  // only by intrinsic phase the performer can neither hear nor see
  // (the cursor wraps on the heard cycle). Store the representative
  // that lands in the FIRST heard window of the intrinsic frame: the
  // take anchors where the cursor actually sweeps, instead of a
  // die-roll among equivalent slots (field: take "started at 1Q
  // instead of 0Q"). Capture still starts at the REAL boundary
  // (`target`); I1 holds exactly (playback shifts by whole heard
  // cycles); nothing else moves (no epoch change — I4). No-op in the
  // mainline (heard == intrinsic when no window is active).
  int64_t origin = target;
  {
    const int64_t heard = island->activeTakeHeardCycle();
    const int64_t intrinsic = island->activeTakeIntrinsicCycle();
    if (heard > 0 && intrinsic > heard) {
      const int64_t rel_t =
          ((target - epoch) % intrinsic + intrinsic) % intrinsic;
      origin = target - (rel_t / heard) * heard;
    }
  }
  origin_samples.store(origin);
  awaiting_start_at.store(target);

  // Start when the compensated clock is at/near the target, or when the
  // target falls inside this block.
  if (compensated_pos >= target || target - compensated_pos < 512) {
    beginCapture(context, target, compensated_pos);
    RtLog::instance().post("ClipNode: Recording Started (at Q boundary)");
  } else if (context.master_pos < target &&
             context.master_pos + context.num_samples >= target) {
    beginCapture(context, target, compensated_pos);
    RtLog::instance().post(
        "ClipNode: Recording Started (crossed Q boundary at %lld)",
        (long long)target);
  }
}

void ClipNode::beginCapture(const ProcessContext& context, int64_t target,
                            int64_t compensated_pos) {
  // The take's HEARD FRAME: the EFFECTIVE island cycle it is being
  // performed against (snapshotted at arm on the island root; falls
  // back to the intrinsic cycle for pre-window engine states). Display
  // take-marking folds by this — "which heard cycle" never matters, the
  // phase within it always does (Q14) — making the mark stable across
  // later frame growth and epoch re-bases.
  celestrian::AudioNode* island = context.island ? context.island : rootNode();
  const int64_t heard = island->activeTakeHeardCycle();
  take_context_cycle_.store(heard > 0 ? heard
                                      : island->activeTakeIntrinsicCycle());

  rec_state_.store((int)RecState::Capturing);
  awaiting_start_at.store(0);
  write_position.store(0);
  live_duration_samples.store(0);
  // Capture window (performance.md §3): clip position 0 holds the input
  // that ARRIVED at performance-time `target`, i.e. (target −
  // compensated) samples after this block's first arrival. A negative
  // delta (boundary just passed) reaches back into the pre-record ring.
  capture_uses_ring_ = (context.prerecord_ring != nullptr);
  capture_next_clock_ = context.input_clock + (target - compensated_pos);
  underrun_logged_ = false;
}

void ClipNode::startRecording(int64_t through_map_commit_cycle) {
  if (recState() != RecState::Idle)
    return;  // idempotent; keeps the
             // island take counter exact

  // D4: VIRTUAL reservation — address space only, deliberately not
  // cleared (touching the pages would commit them; capture writes are
  // the only thing that should). Nothing ever reads past
  // write_position, so the uninitialized tail is unreachable.
  {
    auto& buffer = *content_.load();
    // The take's channel count is fixed HERE (a stereo pair of inputs
    // captures two channels): the audio thread reads capture_channels_
    // only after observing the Armed state stored below.
    capture_channels_ = isStereoInput() ? 2 : 1;
    const int want = (int)std::min<int64_t>(
        kMaxTakeSamples, std::numeric_limits<int>::max() - 64);
    if (buffer.getNumSamples() < want ||
        buffer.getNumChannels() != capture_channels_) {
      buffer.setSize(capture_channels_, want, /*keepExistingContent=*/false,
                     /*clearExtraSpace=*/false, /*avoidReallocating=*/false);
    }
    // THROUGH-MAP take (time_maps.md phase 2, ruling 2): the commit is
    // a dense [0, C) buffer with LITERAL SILENCE in unvisited regions —
    // zero exactly that span now (message thread, clip idle; an
    // audio-thread memset at commit would violate the RT contract).
    // The reservation tail past C stays uncleared per D4.
    if (through_map_commit_cycle > 0) {
      for (int c = 0; c < buffer.getNumChannels(); ++c) {
        buffer.clear(c, 0,
                     (int)std::min<int64_t>(through_map_commit_cycle,
                                            buffer.getNumSamples()));
      }
    }
  }
  map_commit_cycle_.store(through_map_commit_cycle);
  through_map_capture_ = false;
  cap_hit_.store(false);
  write_position.store(0);
  read_position.store(0);
  current_max_peak.store(0.0f);
  awaiting_start_at.store(0);
  stop_requested_.store(false);

  duration_samples.store(0);
  live_duration_samples.store(0);
  is_playing.store(false);

  rec_state_.store((int)RecState::Armed);
  rootNode()->takeArmed();
}

void ClipNode::stopRecording() { stopRecording(getEffectiveQuantum() > 0); }

void ClipNode::stopRecording(bool island_has_quantum) {
  switch (recState()) {
    case RecState::Armed:
      // Never started capturing: stopping an armed clip is a CANCEL —
      // back to Idle with no content. (Previously this wedged the clip
      // into a phantom awaiting-stop before capture had even begun.)
      rec_state_.store((int)RecState::Idle);
      awaiting_start_at.store(0);
      map_commit_cycle_.store(0);
      rootNode()->takeCancelled();
      juce::Logger::writeToLog("ClipNode: Arm cancelled before capture");
      break;

    case RecState::Capturing:
      if (island_has_quantum) {
        // ALWAYS record forward to the next clean boundary (owner
        // ruling). The boundary itself is computed by the AUDIO thread
        // at the top of its next block (see process()) — computing it
        // here from a racing write position was unification_audit.md D2.
        stop_requested_.store(true);
        juce::Logger::writeToLog(
            "ClipNode: Stop requested — finishing to the next boundary");
      } else {
        // First clip: immediate commit. The recorded length stands in
        // for the commit position — a node-level diagnostic only.
        commit_master_pos.store(write_position.load());
        commitRecording();
      }
      break;

    case RecState::PendingStop:
    case RecState::Idle:
      break;  // already stopping / nothing to stop
  }
}

void ClipNode::commitRecording(int64_t final_duration,
                               const ProcessContext* ctx) {
  if (recState() != RecState::Idle) {
    rec_state_.store((int)RecState::Idle);
    stop_requested_.store(false);
    awaiting_stop_at.store(0);

    // Commit fires on the AUDIO thread (from process) with the context,
    // or on the message thread (first-clip immediate stop) without one
    // — the parent walks below are the message/unit-test path only.
    celestrian::AudioNode* island =
        ctx && ctx->island ? ctx->island : rootNode();
    int64_t L = (int64_t)write_position.load();
    int64_t Q = ctx && ctx->quantum > 0 ? ctx->quantum : getEffectiveQuantum();
    int64_t duration = L;

    const int64_t map_C = through_map_capture_ ? map_commit_cycle_.load() : 0;
    if (map_C > 0) {
      // THROUGH-MAP COMMIT (time_maps.md ruling 2): the take IS the
      // mapping node's full inner cycle — one dense buffer, zeroed at
      // arm, content where the mapped clock wrote, literal silence in
      // unvisited regions. Heard-time snapping already chose WHEN this
      // commit fired (stop boundary / one-period cap); C is WHAT
      // commits, so no duration snap applies.
      duration = map_C;
      loop_start_samples.store(0);
      loop_end_samples.store(duration);
      RtLog::instance().post(
          "ClipNode: Through-map commit — C=%lld (heard L=%lld)",
          (long long)map_C, (long long)L);
    } else if (Q > 0 && final_duration <= 0) {
      // Hysteresis snapping — shared math in timing.h.
      auto snap = timing::snapCommittedDuration(L, Q);
      duration = snap.duration;
      loop_start_samples.store(0);
      loop_end_samples.store(snap.loop_end);

      if (snap.snapped) {
        RtLog::instance().post("ClipNode: Late Snap to B=%lld (L=%lld)",
                               (long long)snap.duration, (long long)L);
      } else {
        RtLog::instance().post(
            "ClipNode: Instant Stop at L=%lld (Outside tolerance). Loop "
            "Region set to %lld",
            (long long)L, (long long)snap.loop_end);
      }
    } else if (final_duration > 0) {
      duration = final_duration;
      RtLog::instance().post("ClipNode: Anticipatory Snap to B=%lld",
                             (long long)duration);
      loop_start_samples.store(0);
      loop_end_samples.store(duration);
    } else {
      // No quantum or fallback (first clip case)
      loop_start_samples.store(0);
      loop_end_samples.store(duration);
    }

    duration_samples.store(duration);  // CRITICAL: Store final duration so UI
                                       // knows clip is valid!

    // First committed clip in the island establishes Q — stored once at
    // the island root, never derived again (P0-3; Q survives its
    // creator per owner ruling). Epoch = this clip's origin.
    const int64_t origin = origin_samples.load();
    if (Q == 0) {
      island->establishIsland(duration, origin);
      RtLog::instance().post(
          "ClipNode: Island quantum established: Q=%lld epoch=%lld",
          (long long)duration, (long long)origin);
    }

    // Nothing else to compute: origin was stored at arm and duration
    // above — anchor, launch point, and lane x are all projections of
    // (origin, duration) derived at read time (kernel.md §2 table).
    RtLog::instance().post(
        "ClipNode: Commit. Duration=%lld, Origin=%lld, Launch(derived)=%lld",
        (long long)duration, (long long)origin,
        (long long)timing::launchPointFor(origin, duration));

    is_playing.store(true);

    // The commit EVENT (unification_audit.md §1.5): carries the take's
    // origin to the island root, which owns the epoch re-base decision.
    // Runs AFTER duration_samples is stored so the island's composite
    // duration includes this take — computed here in SNAPSHOT space
    // (audio thread; graph_snapshot.h) and passed in, because the
    // island's own traversal is message-thread-only.
    const int64_t intrinsic_after = ctx && ctx->snap
                                        ? snapIntrinsicDuration(*ctx->snap, 0)
                                        : island->getIntrinsicDuration();
    island->takeCommitted(origin, intrinsic_after);

    // §2.3: the commit block renders silent (see render()); playback
    // begins on the next block, as it always has.
    committed_this_block_.store(true);

    // Through-map take state ends with the take.
    map_commit_cycle_.store(0);
    through_map_capture_ = false;
    take_map_ = timing::TimeMap::none();
    map_anchor_off_ = 0;
  }
}

void ClipNode::startPlayback() {
  if (duration_samples.load() > 0) {
    read_position.store(0);
    is_playing.store(true);
  }
}
// (stopPlayback was deleted with Q16's togglePlay — nothing closed the
// gate except the superseded per-node play verb.)

juce::var ClipNode::getWaveform(int num_peaks) const {
  // D3: the message thread may read clip content ONLY in Idle. A
  // non-Idle clip has no committed content to draw (no-overdub), and
  // the UI synthesizes its live picture from currentPeak. The state
  // load is the publication point: commit stores Idle (seq-cst) after
  // every capture write, so observing Idle here orders those writes
  // before our reads — and only the message thread arms, so Idle
  // cannot flip to Capturing under us. (The old mid-take read was
  // bounded by write_position — an accidental release/acquire edge the
  // through-map fold broke: its destinations scatter across [0, C)
  // while write_position counts HEARD samples, so a bounded read could
  // overlap an in-flight captureWrite.)
  if (recState() != RecState::Idle) return juce::Array<juce::var>();
  const juce::AudioBuffer<float>& buffer = *content_.load();
  juce::Array<juce::var> peaks;
  int total_samples = (int)duration_samples;
  if (total_samples <= 0) total_samples = write_position.load();

  if (total_samples <= 0) return peaks;

  int window_size = std::max(1, total_samples / num_peaks);
  // Content base (Q13 lock-collapse): peaks cover the COMMITTED content
  // [base, base + duration) — the cut material never renders.
  const int64_t base = content_base_.load();
  const int64_t cap = buffer.getNumSamples();
  const int chans = buffer.getNumChannels();

  // Base-relative reads: the content IS the origin frame; the UI
  // positions it via the clip's origin (x), so no other remapping is
  // needed anywhere. Stereo content draws the per-window max of BOTH
  // channels (one waveform per lane).
  for (int i = 0; i < num_peaks; ++i) {
    int start = i * window_size;
    int end = std::max(start + 1, std::min(start + window_size, total_samples));
    float peak = 0.0f;
    if (start < total_samples) {
      for (int c = 0; c < chans; ++c) {
        const float* data = buffer.getReadPointer(c);
        for (int s = start; s < end; ++s) {
          const int64_t idx = base + s;
          if (idx < cap) peak = std::max(peak, std::abs(data[idx]));
        }
      }
    }
    peaks.add(peak);
  }

  return peaks;
}

}  // namespace celestrian
