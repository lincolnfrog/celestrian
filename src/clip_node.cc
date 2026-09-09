// ClipNode — the leaf: one slot (origin + period) holding one or more
// takes (audio samples or MIDI notes) with its loop window and fx rack.
// This file owns
//   - control(): the recording state machine (arm -> capture -> pending
//     stop -> commit), capture from the pre-record ring / MIDI history
//     with latency compensation, the reservation wall guard, through-map
//     takes and new takes of a committed slot;
//   - the arm math (armEvaluate / beginCapture: first-clip epoch, Q-grid
//     targets, through-map anchors, the new-take top) and
//     commitRecording (duration, loop points, island establishment,
//     lifecycle events to the root);
//   - render() / renderMidi(): const playback positioned by origin
//     against the received clock — per Q cell through the comp when one
//     is set — then the output stage (gate -> fx -> gain*pan);
//   - the take list (select / remove / insert / new-take settle), the
//     comp, and the metadata and waveform readouts for the UI.
// Content/storage management (reservations, swaps, trims) lives in
// clip_node.h alongside the state it guards.

#include "clip_node.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>

#include "graph_snapshot.h"
#include "rt_log.h"
#include "timing.h"

namespace celestrian {

ClipNode::ClipNode(juce::String node_name, double source_sample_rate)
    : AudioNode(std::move(node_name)), sample_rate(source_sample_rate) {
  // A LEAF IS ANCHORED BY CONSTRUCTION (Q18): a clip's frame is always
  // its own origin — there is no "received cycle top" case for a
  // performance. One predicate (isAnchored) then serves every node.
  setAnchor(true, 0, 0);
  // Baseline: one second. The real capacity arrives at ARM as a huge
  // virtual reservation (see the take-storage block in the header) and returns
  // to exact size at post-commit compaction — idle clips cost nothing.
  // Floor of 1: a zero-size buffer would make render's `% cap` a SIGFPE
  // (the engine can construct clips before a device reports its rate).
  content_owned_ = std::make_unique<juce::AudioBuffer<float>>(
      1, std::max(1, (int)sample_rate));
  content_owned_->clear();
  content_.store(content_owned_.get());
  fx_scratch_.resize(4096, 0.0f);  // typical max device block
  fx_scratch2_.resize(4096, 0.0f);
  // MIDI content (phase 5): an empty sequence until a MIDI take arms
  // (the arm-time reservation is the note twin of the audio one); the
  // render event buffer is preallocated so addEvent never grows it on
  // the audio thread (kMaxBlockEvents in renderMidi guards the bound).
  midi_owned_ = std::make_unique<MidiSequence>(0);
  midi_.store(midi_owned_.get());
  render_midi_.ensureSize(65536);
}

juce::var ClipNode::getMetadata() const {
  auto base = AudioNode::getMetadata();
  auto* obj = base.getDynamicObject();
  obj->setProperty("sampleRate", sample_rate);
  obj->setProperty("inputChannel", preferred_input_channel.load());
  obj->setProperty("inputChannelR", preferred_input_channel_right.load());
  // Software input monitoring (Q20): the rail's "mon" chip.
  obj->setProperty("monitor", (bool)monitor_.load());
  // 2 when the content is stereo, or the next take will be (stereo
  // inputs assigned): the UI badges the lane either way.
  obj->setProperty("channels",
                   contentChannels() >= 2 || isStereoInput() ? 2 : 1);
  obj->setProperty("isPendingStart", isPendingStart());
  obj->setProperty("isAwaitingStop", isAwaitingStop());
  // The take's heard frame (Q14 take-marking modulus); 0 = first take.
  obj->setProperty("contextCycle", (double)take_context_cycle_.load());
  obj->setProperty("isPlaying", (bool)is_playing.load());
  // Content kind (phase 5): "midi" for a note take — or for an empty
  // clip whose chain carries an instrument (its next take records
  // notes, so the UI shows a MIDI track, not an audio input). The
  // event count is a plain atomic read (diagnostics / lane badge).
  obj->setProperty("contentKind", isMidiClip() ? "midi" : "audio");
  obj->setProperty("midiEvents", midi_.load()->count());
  // The take list (docs/takes.md): count, the active index, and the
  // comp (one take index per Q cell; empty = the active take
  // throughout). A live new take shows in `isRecording` + `takes`.
  obj->setProperty("takes", takeCount());
  obj->setProperty("activeTake", activeTake());
  juce::Array<juce::var> comp;
  for (const int c : compCells()) comp.add(c);
  obj->setProperty("comp", comp);
  return base;
}

int64_t ClipNode::getEffectiveQuantum() const {
  if (auto* p = parent.load()) return p->getEffectiveQuantum();
  return 0;
}

void ClipNode::control(const float* const* input_channels,
                       int num_input_channels, const ProcessContext& context) {
  // The island facts and the snapshot are this pass's only view of the
  // graph (AudioNode::process states the contract).
  jassert(context.snap != nullptr && context.island != nullptr);
  // A new block: last block's commit (if any) has been rendered-silent
  // once; playback proceeds from this block on.
  committed_this_block_.store(false);
  // Adopt the rendering origin (island-generation gate, audio_node.h):
  // a pending origin lands at the block top that also read the epoch
  // it belongs with.
  if (context.island_generation >= origin_gate_gen_.load()) {
    origin_rt_.store(origin_samples.load());
  }

  // === Armed: choose/reach the arm target (state machine, kernel.md §3;
  // re-evaluated every block — deliberate: the latency-compensated clock
  // must be able to land back on a boundary the raw clock already
  // passed). May transition to Capturing within this block.
  if (recState() == RecState::Armed) {
    armEvaluate(context);
  }

  // === Stop request → PendingStop. The boundary is computed HERE, on
  // the audio thread, from the audio thread's own write position — a
  // message-thread computation would race the recorder and could pick
  // a boundary already behind the write head.
  // A parked GROUP stop becomes a request at the first block top whose
  // context carries its generation (ProcessContext::stop_generation) —
  // every member of the group sees it in this same block.
  if (recState() == RecState::Capturing && !stop_requested_.load()) {
    const uint32_t pending = stop_pending_gen_.load();
    if (pending != 0 && context.stop_generation >= pending) {
      stop_requested_.store(true);
      stop_pending_gen_.store(0);
    }
  }
  if (recState() == RecState::Capturing && stop_requested_.load() &&
      retake_period_.load() > 0) {
    // NEW TAKE, stopped short (docs/takes.md): nothing shorter than the
    // period can be a take of this slot, so the stop CANCELS it. The
    // previous active take comes back at settleRetake (message thread)
    // — the clip stays silent until then.
    rec_state_.store((int)RecState::Idle);
    stop_requested_.store(false);
    retake_period_.store(0);
    retake_cancelled_.store(true);
    context.island->takeCancelled();
    RtLog::instance().post(
        "ClipNode: new take cancelled before its period (L=%lld) - the "
        "previous take stands",
        (long long)write_position.load());
    return;
  }
  if (recState() == RecState::Capturing && stop_requested_.load()) {
    // Island Q rides the context (no audio-thread parent walks).
    const int64_t Q = context.quantum;
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

  // Handle Recording (Capturing or PendingStop). A MIDI take (phase 5)
  // captures notes instead of samples — the same lifecycle, a
  // different ingest; everything after finishCaptureBlock is shared.
  if (isRecording() && contentKind() == ContentKind::Midi) {
    captureMidiBlock(context);
  } else if (isRecording()) {
    // ONE content load per control pass (the message thread swaps this
    // pointer only for idle clips, never mid-capture).
    juce::AudioBuffer<float>& buffer = *content_.load();

    // Wall guard — integrity, not policy: the arm-time reservation
    // is ~hours, but IF capture ever nears it, finish CLEANLY at the
    // last boundary that fits instead of silently dropping audio.
    if (recState() == RecState::Capturing && !stop_requested_.load()) {
      // The wall is the COMMITTED edge of the reserved storage (the
      // grower keeps a headroom ahead; only a stalled message thread
      // reaches it), else the buffer's extent.
      const int64_t cap = writableCapacity();
      const int64_t wp = write_position.load();
      const int64_t Q = context.quantum;
      if (Q > 0) {
        if (cap - wp <= Q + 8192) {  // next boundary must still fit
          stop_requested_.store(true);
          cap_hit_.store(true);
          RtLog::instance().post(
              "ClipNode: take reached the reservation bound - finishing "
              "at the last clean boundary");
        }
      } else if (cap - wp <= context.num_samples) {
        // Pre-Q first take: commit at the wall (duration = written).
        commit_master_pos.store(context.master_pos);
        cap_hit_.store(true);
        RtLog::instance().post(
            "ClipNode: first take reached the reservation bound - "
            "committed at %lld samples",
            (long long)wp);
        commitRecording(-1, &context);
        return;
      }
    }
    if (capture_uses_ring_ && context.prerecord_ring != nullptr &&
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
        // every block, and per-block posts would keep the drain FIFO
        // permanently full (a log storm hangs the message thread).
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
        int64_t space = buffer.getNumSamples() - capture_base_ - wp;
        // The heard-length cap: one map pass (through-map, ruling 2) or
        // one period (a new take) — no overdub by construction.
        if (capture_cap_ > 0) space = std::min(space, capture_cap_ - wp);
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
            const int ch =
                std::clamp(c == 0 ? preferred_input_channel.load()
                                  : preferred_input_channel_right.load(),
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
    } else if (input_channels != nullptr && num_input_channels > 0) {
      int64_t space =
          buffer.getNumSamples() - capture_base_ - write_position.load();
      // The heard-length cap — see the ring path.
      if (capture_cap_ > 0) {
        space = std::min(space, capture_cap_ - write_position.load());
      }
      const int samples_to_write =
          (int)std::min<int64_t>(context.num_samples, space);

      if (samples_to_write > 0) {
        const int ncap = std::min(capture_channels_, buffer.getNumChannels());
        // Peak tracking over the CAPTURED channels only — the meter
        // reports the take, not the device (same as the ring path).
        float blockPeak = 0.0f;
        for (int c = 0; c < ncap; ++c) {
          const float* in = input_channels[std::clamp(
              c == 0 ? preferred_input_channel.load()
                     : preferred_input_channel_right.load(),
              0, num_input_channels - 1)];
          if (in == nullptr) continue;  // device delivered a null channel
          captureWrite(buffer, c, write_position.load(), in, samples_to_write);
          for (int i = 0; i < samples_to_write; ++i) {
            blockPeak = std::max(blockPeak, std::abs(in[i]));
          }
        }
        finishCaptureBlock(samples_to_write, blockPeak, context);
      }
      // samples_to_write <= 0 means the buffer is full: the wall guard
      // at the top of this pass has already requested a clean
      // finish at the last boundary that fits (or committed a pre-Q
      // take at the wall), so there is nothing to do here.
    }
  }
}

void ClipNode::finishCaptureBlock(int written, float block_peak,
                                  const ProcessContext& context) {
  last_block_peak.store(block_peak);

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
  // The cap wall: a full map pass, or a new take's full period,
  // auto-finishes CLEANLY (the wall-guard discipline; the cap IS a
  // boundary).
  if (capture_cap_ > 0 && end_position >= capture_cap_) {
    commit_master_pos.store(context.master_pos);
    RtLog::instance().post(
        "ClipNode: take completed its cap (%lld samples) - committing",
        (long long)capture_cap_);
    commitRecording(-1, &context);
  }
}

void ClipNode::captureWrite(juce::AudioBuffer<float>& buffer, int dest_ch,
                            int64_t heard_pos, const float* src, int n) {
  if (!through_map_capture_) {
    // Linear: content position p lands at base + p (capture_base_ is
    // the slot's shared base for a new take, 0 for a fresh clip).
    buffer.copyFrom(dest_ch, (int)(capture_base_ + heard_pos), src, n);
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

void ClipNode::captureMidiBlock(const ProcessContext& context) {
  const int wp = write_position.load();
  // The heard-length ceiling: the reservation bound (integrity), and
  // the cap — one map pass, or a new take's period (same as samples).
  int64_t space = kMaxTakeSamples - wp;
  if (capture_cap_ > 0) space = std::min(space, capture_cap_ - wp);
  float block_peak = 0.0f;

  if (context.midi_history != nullptr) {
    // ARRIVAL-TIME CAPTURE — the note twin of the pre-record ring path
    // (docs/performance.md §3): content position wp corresponds to
    // arrival index midi_capture_next_clock_ (fixed at beginCapture
    // with the MIDI compensation baked in), and this block covers the
    // arrivals up to available_end. Events that arrived BEFORE the
    // window (a lead of compensation) are skipped: they precede the
    // take. The write head advances by heard samples exactly as the
    // audio path's does, so stop boundaries and commit snapping are
    // content-agnostic.
    const MidiHistory& hist = *context.midi_history;
    const int64_t available_end = context.input_clock + context.num_samples;
    const int64_t src = midi_capture_next_clock_;
    if (src >= available_end) return;  // window not reached yet
    const int n = (int)std::min<int64_t>(available_end - src, space);
    if (n <= 0) return;
    if (midi_history_cursor_ < hist.oldestSeq()) {
      // The ring overwrote entries this take had not consumed yet —
      // impossible at human event rates; drop-and-count, one log line.
      if (!midi_lost_logged_) {
        midi_lost_logged_ = true;
        RtLog::instance().post(
            "ClipNode: MIDI history overrun, %lld events lost",
            (long long)(hist.oldestSeq() - midi_history_cursor_));
      }
      midi_history_cursor_ = hist.oldestSeq();
    }
    // The window's first block folds the PRELUDE: a note struck before
    // the window and still down when it opens is sounding at the take's
    // top, so it lands as a note-on at content 0 (I1) — before any
    // in-window event, so a release at exactly content 0 still follows
    // its note-on.
    auto foldPrelude = [&]() {
      if (midi_prelude_folded_) return;
      midi_prelude_folded_ = true;
      capture_prelude_.forEachHeld([&](int ch, int note, juce::uint8 vel) {
        const juce::uint8 on[3] = {(juce::uint8)(0x90 | ch), (juce::uint8)note,
                                   vel};
        captureMidiEvent(wp, on, 3, block_peak);
      });
      capture_prelude_.clear();
    };
    while (midi_history_cursor_ < hist.total()) {
      const MidiHistory::Entry& e = hist.entry(midi_history_cursor_);
      if (e.arrival >= src + n) break;  // past this block's window
      ++midi_history_cursor_;
      if (e.arrival < src) {  // precedes the take: prelude bookkeeping
        capture_prelude_.track(e.bytes, e.size);
        continue;
      }
      foldPrelude();
      captureMidiEvent(wp + (e.arrival - src), e.bytes, e.size, block_peak);
    }
    foldPrelude();
    midi_capture_next_clock_ = src + n;
    if (block_peak <= 0.0f && capture_held_.any())
      block_peak = last_block_peak.load();  // sustain the meter while held
    finishCaptureBlock(n, block_peak, context);
    return;
  }

  // Live-block fallback (no history: unit tests driving nodes
  // directly): the block's events at their offsets, uncompensated —
  // the same fallback the audio path takes without a ring.
  const int n = (int)std::min<int64_t>(context.num_samples, space);
  if (n <= 0) return;
  if (context.live_midi != nullptr) {
    for (const auto metadata : *context.live_midi) {
      if (metadata.samplePosition >= n) break;
      captureMidiEvent(wp + std::max(0, metadata.samplePosition),
                       metadata.data, metadata.numBytes, block_peak);
    }
  }
  if (block_peak <= 0.0f && capture_held_.any())
    block_peak = last_block_peak.load();
  finishCaptureBlock(n, block_peak, context);
}

void ClipNode::captureMidiEvent(int64_t pos, const juce::uint8* bytes,
                                int size, float& block_peak) {
  if (pos < 0 || size <= 0 || size > 3) return;
  if (capture_cap_ > 0 && pos >= capture_cap_) return;  // beyond the cap
  int64_t dest = capture_base_ + pos;
  if (through_map_capture_) {
    // THROUGH-MAP FOLD (time_maps.md §3), the point version of
    // captureWrite: the note lands at the inner position the
    // performance was heard against, inside the dense [0, C) content.
    dest = timing::throughMapDest(pos, map_anchor_off_, take_map_,
                                  map_commit_cycle_.load());
  }
  midi_.load()->append(dest, bytes, size);
  // The take meter reads velocity: note-ons peak it, held notes
  // sustain it (captureMidiBlock), releases let it fall.
  if (capture_held_.track(bytes, size) && (bytes[0] & 0xF0) == 0x90 &&
      bytes[2] > 0) {
    block_peak = std::max(block_peak, (float)bytes[2] / 127.0f);
  }
}

bool ClipNode::isSilencedThisBlock(const ProcessContext& context) const {
  bool silenced = is_muted.load() || context.any_solo;
  if (silenced && !is_muted.load()) {
    // Solo audibility (Q16 canon): with any solo lit anywhere in the
    // island, a leaf sounds iff it — or an ancestor — is soloed
    // (additive: every lit path sounds; fractal: a soloed group covers
    // its subtree). Index walk over the whole-graph snapshot — the
    // audio thread never chases parent pointers. Mute wins over solo
    // (the container rule pinned in output_stage_tests).
    silenced = !snapIsUnderSolo(*context.snap, context.self);
  }
  return silenced;
}

void ClipNode::render(float* const* output_channels, int num_output_channels,
                      const ProcessContext& context) const {
  jassert(context.snap != nullptr && context.island != nullptr);
  // A MIDI clip (phase 5) renders notes through its instrument — the
  // same kernel equation over a note sequence; one path handles
  // content, live play-through, and tails.
  if (contentKind() == ContentKind::Midi) {
    renderMidi(output_channels, num_output_channels, context);
    return;
  }
  // ONE content load per render (compaction may swap the pointer under
  // a playing clip; the retired buffer outlives this block).
  const juce::AudioBuffer<float>& buffer = *content_.load();
  // Whether the content branch rendered the scratch pair this block —
  // the live tail below (input monitoring, MIDI play-through) runs
  // only when it did not, so the chain never runs a SECOND time (echo
  // lines and plugin state advance per run) and the monitored input
  // is added exactly once.
  bool content_rendered = false;
  // The kernel playback equation (§2.3 render phase): a pure function
  // of (buffer, origin, window, t). The commit block renders SILENT
  // (committed_this_block_).
  if (context.is_playing && is_playing && !committed_this_block_.load()) {
    // The clip's map, fractal (I5): a multi-segment override, or the
    // loop region as the single-segment case. BYPASSED (or invalid)
    // maps fall back to the full take (commit sets [0, duration) on
    // every clip).
    timing::TimeMap map = activeTimeMap();
    if (!map.active()) {
      map = timing::TimeMap::single(0, duration_samples.load());
    }
    const int64_t dur = map.period();

    if (dur > 0) {
      // THE PRE-FX GATE (S7 smoothness law, docs/sequencer.md §9):
      // mute/solo-loss (Q16 canon — isSilencedThisBlock) resolve to a
      // ~10 ms ramp, composed with any parent-sequence envelope from
      // the context. Applied to the DRY signal below, BEFORE the fx
      // pass — so gate edges never pop and the chain keeps running
      // while anything rings (a muted clip's echo tail decays audibly
      // instead of freezing).
      float gate_g0 = 1.0f, gate_g1 = 1.0f;
      gateEndpoints(context, !isSilencedThisBlock(context), gate_g0, gate_g1);
      // A bounce tail (content_silent) is a closed gate without the
      // ramp: the buffer rests, the chain hears silence, the tail rings.
      const bool fully_off =
          (gate_g0 <= 0.0f && gate_g1 <= 0.0f) || context.content_silent;
      const bool isSilenced = fully_off && !fxIsLive();

      // Audio Memory Principle — the kernel playback equation
      // (docs/kernel.md §2), generalized through the map (phase 3, the
      // ANCHORING LAW): clip map playback ≡ the stack map with
      // epoch := origin + mapOffset(0):
      //
      //   p(t) = mapOffset((t − origin − mapOffset(0)) mod period)
      //
      // The single-segment case p(t) = start + ((t − origin − start)
      // mod len) IS the `origin + loopStart` anchoring (window content
      // sounds at its OWN performed moment); the un-mapped case reduces
      // to (t − origin) mod dur, the plain loop equation. Later
      // segments shift earlier by the removed time —
      // punch semantics; groove-transparent when cuts are kQ (seam
      // theorem).
      const int64_t org = origin_rt_.load();
      // THE PERIOD-SOURCE KNOB (Q5): a one-shot's period is the
      // context cycle, so the phase folds on P = context_cycle and
      // content sounds only while the phase is inside [0, dur) — the
      // rest of the cycle renders honest SILENCE through the same
      // scratch (so the fx rack hears it and echo/reverb tails ring
      // out naturally after the shot). P == dur (knob off, or a
      // degenerate context no longer than the content) reduces to the
      // plain loop equation exactly.
      const int64_t cyc =
          period_from_context_.load() && context.context_cycle > dur
              ? context.context_cycle
              : dur;

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
        const bool stereo_content = buffer.getNumChannels() >= 2;
        // Software input monitoring (Q20) joins the dry signal below;
        // a closed gate adds nothing (muted stays silent).
        const bool monitoring = !fully_off && monitorLive(context);
        // scratch2 is also the PROMOTION target (Q-V1): a mono clip
        // with a live chain may come back stereo from the fx pass — or
        // a stereo input pair may promote it under monitoring.
        if ((stereo_content || monitoring || fxIsLive()) &&
            (int)fx_scratch2_.size() < context.num_samples) {
          fx_scratch2_.resize((size_t)context.num_samples);
        }
        // THE COMP (docs/takes.md): with a comp set, each Q cell of the
        // period names the take that sounds there; the table is read
        // ONCE per render (seqlock) and cell boundaries become seams —
        // a run never crosses a cell, so every run reads one buffer.
        CompView comp;
        if (comp_n_.load(std::memory_order_relaxed) > 0) readCompView(comp);
        // THE CONTENT RUN SPLITTER (timing::forEachContentRun — the one
        // statement of the render equation, shared with renderMidi):
        // runs never cross a map seam, the shot end, the rest, or a comp
        // cell, so each run is one contiguous read of one buffer. A
        // fully-closed gate skips the read and feeds the chain silence —
        // the tail rings, the buffer rests.
        const int64_t cell_len = comp.n > 0 ? comp.q : 0;
        for (int c = 0; c < (stereo_content ? 2 : 1); ++c) {
          const float* data = buffer.getReadPointer(c);
          float* scratch = c == 0 ? fx_scratch_.data() : fx_scratch2_.data();
          if (fully_off) {
            std::fill(scratch, scratch + context.num_samples, 0.0f);
            continue;
          }
          timing::forEachContentRun(
              context.master_pos, context.num_samples, org, map, cyc, cell_len,
              [&](int i, int run, const timing::InnerAt& at) {
                if (at.rest) {  // one-shot rest region: honest silence
                  std::fill(scratch + i, scratch + i + run, 0.0f);
                  return;
                }
                const int64_t p0 = at.inner;
                const float* src = data;
                int64_t src_cap = cap;
                if (cell_len > 0) {
                  const int64_t cell = p0 / cell_len;
                  const int pick = cell < comp.n ? comp.cells[cell] : -1;
                  if (pick >= 0 && pick < comp.count && pick != comp.active &&
                      comp.buffers[pick] != nullptr &&
                      comp.buffers[pick]->getNumSamples() > 0) {
                    const juce::AudioBuffer<float>& tb = *comp.buffers[pick];
                    src = tb.getReadPointer(
                        std::min(c, tb.getNumChannels() - 1));
                    src_cap = tb.getNumSamples();
                  }
                }
                for (int k = 0; k < run; ++k) {
                  scratch[(size_t)(i + k)] = src[(base + p0 + k) % src_cap];
                }
              });
        }
        // SOFTWARE INPUT MONITORING (Q20): this block's arrivals, read
        // from the pre-record ring, join the dry signal HERE — ahead of
        // the gate and the rack — so the input takes the clip's gate,
        // chain, gain and pan exactly like content. The callback wrote
        // this block into the ring before the graph rendered, so the
        // monitored input carries no latency beyond the device round
        // trip. A bounce carries no ring: monitoring never reaches a
        // bounce (pinned by tests/monitor_tests.cc).
        bool stereo = stereo_content;
        if (monitoring) stereo = addMonitorInput(context, stereo);
        // THE GATE, pre-fx (S7): linear g0→g1 across the block — exact
        // (the parent split the block at envelope corners; the mute
        // ramp advances at most one fade-step per block).
        if (!fully_off && !(gate_g0 >= 1.0f && gate_g1 >= 1.0f)) {
          applyGate(gate_g0, gate_g1, stereo, context.num_samples);
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
        }
        content_rendered = true;
        // The output stage (unification_audit §2.4): gain·pan resolved
        // together, post-fx. Mute short-circuited above (isSilenced),
        // so the fader here is just `gain`.
        sumOutputStage(output_channels, num_output_channels, out_stereo,
                       context.num_samples);
      }

      // Update playhead position for UI (0..1): the heard phase of the
      // map pass — identical to the launch-point form for single
      // segments. One-shots phase over their FULL period (the context
      // cycle), so the sweep is honest about the rest region.
      playhead_pos.store(
          (double)timing::innerAt(context.master_pos, org, map, cyc).h /
          (double)cyc);
    } else {
      playhead_pos.store(0.0);
    }
  }

  // --- The live tail: input monitoring (Q20) + MIDI play-through
  // (docs/vst3.md §8, phase 4) ---
  // Both sound INDEPENDENT of transport and content. When the content
  // branch did not render this block (stopped transport, empty clip,
  // a pending or capturing take — a capturing clip renders no content,
  // so the monitored input never doubles), the dry signal is the
  // monitored input (or silence), gated, run once through the chain
  // with the live events so the synth speaks under the player's
  // hands, and summed at the output stage. Muted / solo-silenced nodes
  // stay quiet — the same audibility rule content follows.
  const bool monitoring = monitorLive(context);
  const bool midi_live = midi_armed.load() && context.live_midi != nullptr &&
                         fxChain()->hasEnabledInstrument();
  if (!content_rendered && (monitoring || midi_live) &&
      !isSilencedThisBlock(context)) {
    const int n = context.num_samples;
    if ((int)fx_scratch_.size() < n) fx_scratch_.resize((size_t)n);
    if ((int)fx_scratch2_.size() < n) fx_scratch2_.resize((size_t)n);
    std::fill(fx_scratch_.begin(), fx_scratch_.begin() + n, 0.0f);
    std::fill(fx_scratch2_.begin(), fx_scratch2_.begin() + n, 0.0f);
    bool stereo = false;
    if (monitoring) {
      stereo = addMonitorInput(context, false);
      // The pre-fx gate (S7) over the input: the mute/solo ramp times
      // the parent's sequence envelope — content's law, so an unmute
      // fades the input in and a sequence step gates it.
      float gate_g0 = 1.0f, gate_g1 = 1.0f;
      gateEndpoints(context, true, gate_g0, gate_g1);
      if (!(gate_g0 >= 1.0f && gate_g1 >= 1.0f)) {
        applyGate(gate_g0, gate_g1, stereo, n);
      }
    }
    bool out_stereo = stereo;
    if (fxIsLive()) {
      // A pure play-through feeds mono silence: the chain promotes at
      // the instrument slot and the synth overwrites. The device-stop
      // sound-off (docs/vst3.md §11) rides this path too: the pair on
      // the channels the live events have used, ahead of this block's
      // events, through the preallocated render buffer.
      const juce::MidiBuffer* live = liveMidiFor(context);
      if (live != nullptr) {
        for (const auto metadata : *live) {
          if (metadata.numBytes > 0 && metadata.data[0] < 0xF0)
            midi_channels_in_use_ |= (juce::uint16)(1u << (metadata.data[0] & 0x0F));
        }
      }
      if (midi_sound_off_pending_.exchange(false) && midi_channels_in_use_) {
        render_midi_.clear();
        addSoundOff(render_midi_, midi_channels_in_use_, 0);
        midi_channels_in_use_ = 0;
        if (live != nullptr) render_midi_.addEvents(*live, 0, n, 0);
        live = &render_midi_;
      }
      out_stereo = fxProcess(fx_scratch_.data(), fx_scratch2_.data(), n,
                             stereo, live);
    }
    sumOutputStage(output_channels, num_output_channels, out_stereo, n);
  }
}

bool ClipNode::addMonitorInput(const ProcessContext& context,
                               bool stereo) const {
  const int n = context.num_samples;
  const int ring_len = context.prerecord_ring_len;
  const int idx = (int)(context.input_clock % ring_len);
  const int first = std::min(n, ring_len - idx);
  const int channels = context.prerecord_ring_channels;
  const int left = preferred_input_channel.load();
  const int right = preferred_input_channel_right.load();
  const bool has_left = left >= 0 && left < channels;
  const bool has_right = right >= 0 && right < channels;
  auto add = [&](int ch, float* scratch) {
    const float* ring = context.prerecord_ring[ch];
    juce::FloatVectorOperations::add(scratch, ring + idx, first);
    if (n > first) {
      juce::FloatVectorOperations::add(scratch + first, ring, n - first);
    }
  };
  if (has_right && !stereo) {
    std::fill(fx_scratch2_.begin(), fx_scratch2_.begin() + n, 0.0f);
    stereo = true;
  }
  if (has_left) {
    add(left, fx_scratch_.data());
    if (!has_right && stereo) add(left, fx_scratch2_.data());
  }
  if (has_right) add(right, fx_scratch2_.data());
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
  // Pan (balance law, audio_node.h): output channel 0 is L, channel 1
  // is R. A mono pair pans between them (center is unity on both); a
  // stereo pair treats pan as balance (attenuate the far side). A mono
  // OUTPUT hears the unpanned center at the fader (channels ≥ 2, if
  // any, likewise get the fader-scaled unpanned mono sum).
  float gl = 1.0f, gr = 1.0f, fader = 1.0f;
  outputStageGains(pan.load(), gain.load(), gl, gr, fader);
  for (int ch = 0; ch < num_output_channels; ++ch) {
    if (output_channels[ch] == nullptr) continue;
    const bool right = ch == 1 && num_output_channels >= 2;
    const float* src =
        stereo && right ? fx_scratch2_.data() : fx_scratch_.data();
    float g = fader;
    if (num_output_channels >= 2 && ch < 2) g = right ? gr : gl;
    if (stereo && num_output_channels < 2) {
      // Fold the stereo pair to a mono device: equal halves.
      if (fader <= 0.0f) continue;
      juce::FloatVectorOperations::addWithMultiply(
          output_channels[ch], fx_scratch_.data(), 0.5f * fader, n);
      juce::FloatVectorOperations::addWithMultiply(
          output_channels[ch], fx_scratch2_.data(), 0.5f * fader, n);
      continue;
    }
    if (g == 1.0f) {
      juce::FloatVectorOperations::add(output_channels[ch], src, n);
    } else if (g > 0.0f) {
      juce::FloatVectorOperations::addWithMultiply(output_channels[ch], src,
                                                   g, n);
    }
  }
}

void ClipNode::renderMidi(float* const* output_channels,
                          int num_output_channels,
                          const ProcessContext& context) const {
  // Guard on the preallocated event buffer (render_midi_ is sized in
  // the constructor; addEvent must never grow it here).
  constexpr int kMaxBlockEvents = 4096;
  const MidiSequence& seq = *midi_.load();
  const int n = context.num_samples;
  if (n <= 0) return;
  render_midi_.clear();
  int events_added = 0;
  // Every event handed to the instrument marks its channel: the
  // sound-off pair goes to exactly the channels in use.
  auto addEvent = [&](const juce::uint8* bytes, int size, int offset) {
    render_midi_.addEvent(bytes, size, offset);
    if (size > 0 && bytes[0] < 0xF0)
      midi_channels_in_use_ |= (juce::uint16)(1u << (bytes[0] & 0x0F));
    ++events_added;
  };

  // The S7 gate for this block (mute / solo-silence composed with the
  // parent sequence's envelope), resolved FIRST: its closing is a
  // sound-off edge below, and the same endpoints gate the output.
  float gate_g0 = 1.0f, gate_g1 = 1.0f;
  gateEndpoints(context, !isSilencedThisBlock(context), gate_g0, gate_g1);
  const bool gate_closed = gate_g1 <= 0.0f;

  // A CLOSING EDGE (docs/vst3.md §11): release what the content had
  // sounding, then the sound-off pair on every channel in use — once
  // per edge, never per block. The instrument's own envelope carries
  // the release; the chain after it rings through the tail below.
  bool sound_off_sent = false;
  auto closingEdge = [&](int offset) {
    render_held_.releaseInto(render_midi_, offset);
    if (sound_off_sent || midi_channels_in_use_ == 0) return;
    addSoundOff(render_midi_, midi_channels_in_use_, offset);
    midi_channels_in_use_ = 0;
    sound_off_sent = true;
    ++events_added;
  };

  // === CONTENT: the kernel playback equation over the note sequence
  // (docs/kernel.md §2, generalized through the map exactly as the
  // audio path — same run split, same one-shot rest, same anchoring
  // law). Each run covers content [p0, p0 + run); its events land at
  // block offset i + (pos − p0): sample-accurate. A DISCONTINUITY in
  // the covered content (loop seam, map seam, one-shot rest, transport
  // stop) releases whatever the content had sounding — the "hanging
  // notes closed at the seam" rule (docs/vst3.md §8), tracked in
  // render_held_.
  bool content_active = false;
  // A bounce tail (content_silent) is a content stop: held notes
  // release below and the instrument's own release rings through.
  if (context.is_playing && is_playing && !committed_this_block_.load() &&
      !context.content_silent) {
    timing::TimeMap map = activeTimeMap();
    if (!map.active()) {
      map = timing::TimeMap::single(0, duration_samples.load());
    }
    const int64_t dur = map.period();
    if (dur > 0) {
      content_active = true;
      const int64_t org = origin_rt_.load();
      const int64_t base = content_base_.load();
      const int64_t cyc =
          period_from_context_.load() && context.context_cycle > dur
              ? context.context_cycle
              : dur;
      // The same run splitter as the audio render (timing.h): one
      // equation, one seam discipline for notes and samples.
      timing::forEachContentRun(
          context.master_pos, n, org, map, cyc, /*cell_len=*/0,
          [&](int i, int run, const timing::InnerAt& at) {
            if (at.rest) {  // one-shot rest region: nothing sounds
              if (midi_render_next_pos_ >= 0) {
                render_held_.releaseInto(render_midi_, i);
                midi_render_next_pos_ = -1;
              }
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
      // Playhead (0..1): the heard phase of the pass; one-shots phase
      // over their full period (the context cycle).
      playhead_pos.store(
          (double)timing::innerAt(context.master_pos, org, map, cyc).h /
          (double)cyc);
    } else {
      playhead_pos.store(0.0);
    }
  }
  if (!content_active && midi_content_was_active_) {
    // Content stopped (transport stop, a new take's silence, a bounce
    // tail): a closing edge, right now.
    closingEdge(0);
    midi_render_next_pos_ = -1;
  }
  midi_content_was_active_ = content_active;
  // The S7 gate reaching fully closed (mute, solo-silence, a sequence
  // cut) is a closing edge — placed where the ramp lands on zero, so
  // the instrument falls silent under an already-closed gate (no pop)
  // and the content keeps feeding it meanwhile (an unmute resumes
  // mid-phrase). The device-stop request is the same edge at the top.
  if (gate_closed && !midi_gate_was_closed_)
    closingEdge(gate_g0 > 0.0f ? n - 1 : 0);
  midi_gate_was_closed_ = gate_closed;
  if (midi_sound_off_pending_.exchange(false)) closingEdge(0);

  // === LIVE PLAY-THROUGH (phase 4): the armed node's events at their
  // block offsets. Not tracked in render_held_ — the player's own
  // fingers own those releases.
  if (midi_armed.load() && context.live_midi != nullptr) {
    for (const auto metadata : *context.live_midi) {
      if (events_added >= kMaxBlockEvents) break;
      addEvent(metadata.data, metadata.numBytes,
               std::clamp(metadata.samplePosition, 0, n - 1));
    }
  }

  // === ONE chain run over silence, from the instrument down. The
  // chain runs whenever something is (or was just) sounding: content
  // playing, live events, releases pending, or the release tail after
  // either (kTailSeconds — the instrument's envelopes and any effect
  // after it ring out; an idle MIDI clip costs nothing after that).
  constexpr double kTailSeconds = 4.0;
  if (content_active || events_added > 0) {
    midi_tail_samples_left_ = (int64_t)(context.sample_rate * kTailSeconds);
  }
  if (!fxChain()->hasEnabledInstrument()) return;  // nothing generates
  if (midi_tail_samples_left_ <= 0) return;
  midi_tail_samples_left_ -= n;

  if ((int)fx_scratch_.size() < n) fx_scratch_.resize((size_t)n);
  if ((int)fx_scratch2_.size() < n) fx_scratch2_.resize((size_t)n);
  std::fill(fx_scratch_.begin(), fx_scratch_.begin() + n, 0.0f);
  std::fill(fx_scratch2_.begin(), fx_scratch2_.begin() + n, 0.0f);
  // Mono silence in; the chain promotes at the instrument slot and the
  // synth overwrites — stereo out by construction.
  fxProcess(fx_scratch_.data(), fx_scratch2_.data(), n, /*stereo_in=*/false,
            &render_midi_);

  // Mute gates the OUTPUT here (a silenced MIDI clip still FEEDS its
  // instrument, so an unmute resumes mid-phrase and no note hangs) —
  // ramped per S7 (no pops), composed with any parent-sequence
  // envelope from the context; the endpoints were resolved at the top.
  if (gate_g0 <= 0.0f && gate_g1 <= 0.0f) return;
  if (!(gate_g0 >= 1.0f && gate_g1 >= 1.0f)) {
    const float dg = (gate_g1 - gate_g0) / (float)std::max(1, n);
    for (int c = 0; c < 2; ++c) {
      float* scratch = c == 0 ? fx_scratch_.data() : fx_scratch2_.data();
      float g = gate_g0;
      for (int i = 0; i < n; ++i, g += dg) scratch[(size_t)i] *= g;
    }
  }
  float gl = 1.0f, gr = 1.0f, fader = 1.0f;
  outputStageGains(pan.load(), gain.load(), gl, gr, fader);
  for (int ch = 0; ch < num_output_channels; ++ch) {
    if (output_channels[ch] == nullptr) continue;
    const bool right = ch == 1 && num_output_channels >= 2;
    const float* src = right ? fx_scratch2_.data() : fx_scratch_.data();
    if (num_output_channels < 2) {
      // Fold the stereo pair to a mono device: equal halves.
      if (fader <= 0.0f) continue;
      juce::FloatVectorOperations::addWithMultiply(output_channels[ch],
                                                   fx_scratch_.data(),
                                                   0.5f * fader, n);
      juce::FloatVectorOperations::addWithMultiply(output_channels[ch],
                                                   fx_scratch2_.data(),
                                                   0.5f * fader, n);
      continue;
    }
    const float g = ch < 2 ? (right ? gr : gl) : fader;
    if (g > 0.0f) {
      juce::FloatVectorOperations::addWithMultiply(output_channels[ch], src,
                                                   g, n);
    }
  }
}

void ClipNode::armEvaluate(const ProcessContext& context) {
  // Island facts ride the context: quantum, invariant epoch, and the
  // island root itself — no audio-thread parent walks.
  const int64_t Q = context.quantum;
  celestrian::AudioNode* island = context.island;

  // Latency compensation: the performer plays against what they HEARD
  // (delayed by output latency); it reaches the software input latency
  // later. context.input_latency carries the whole round trip (input +
  // output, or the calibrated figure the engine substitutes for both).
  int64_t compensated_pos =
      context.master_pos - context.input_latency;
  if (compensated_pos < 0) compensated_pos = 0;

  // === NEW TAKE (docs/takes.md): the slot already has an origin and a
  // period, so the target is the slot's own next top in the heard
  // frame — t ≡ origin (mod period) — and the new take starts at the
  // clip's top by construction (same origin, never re-derived). Judged
  // before the first-clip branch: a committed slot is never pre-Q.
  if (const int64_t P = retake_period_.load(); P > 0) {
    const int64_t O = origin_samples.load();
    int64_t rel = compensated_pos - O;
    if (rel < 0) rel = 0;
    const int64_t target = O + ((rel + P - 1) / P) * P;
    awaiting_start_at.store(target);
    if (compensated_pos >= target || target - compensated_pos < 512) {
      beginCapture(context, target, compensated_pos);
      RtLog::instance().post("ClipNode: New take started at the slot top");
    } else if (context.master_pos < target &&
               context.master_pos + context.num_samples >= target) {
      beginCapture(context, target, compensated_pos);
      RtLog::instance().post(
          "ClipNode: New take started (crossed the slot top at %lld)",
          (long long)target);
    }
    return;
  }

  if (Q <= 0) {
    // First clip: starts NOW. This arm moment IS the island epoch —
    // captured as data at the root (the clock is never reset,
    // kernel.md); commit stores Q + epoch together with the same value.
    origin_samples.store(compensated_pos);
    origin_rt_.store(compensated_pos);
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
        context.island_pos - context.input_latency;
    if (heard < 0) heard = 0;
    int64_t rel_h = heard - context.map_heard_epoch;
    if (rel_h < 0) rel_h = 0;

    const int64_t t_rel = timing::armTarget(rel_h, Q, period);
    const int64_t heard_target = context.map_heard_epoch + t_rel;
    // The anchor's inner position, absolute: segments select view
    // positions of the mapping node's received frame, whose cycle top
    // is map_heard_epoch (the one-frame rule, time_maps.md §2).
    // (Q18: the map's inner positions are offsets from the mapping
    // stack's ORIGIN — map_origin; map_heard_epoch = map_origin + a0.)
    const int64_t origin = context.map_origin + context.map.mapOffset(t_rel);

    origin_samples.store(origin);
    origin_rt_.store(origin);
    awaiting_start_at.store(heard_target);

    const bool reached =
        heard >= heard_target || heard_target - heard < 512 ||
        (context.island_pos < heard_target &&
         context.island_pos + context.num_samples >= heard_target);
    if (reached) {
      // Freeze the take's map facts before capture begins.
      take_map_ = context.map;
      map_anchor_off_ = timing::posMod(t_rel, period);
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
  // absolute-frame math with the epoch-rebased view anchors a take
  // whole cycles off. The INVARIANT epoch rides the context
  // (cycle_epoch gets re-based by windowed stacks; this one never is).
  const int64_t epoch = context.island_epoch;

  // The arm grid = the loop the performer was listening to: the scope's
  // CONTEXT CYCLE (the one scope cycle, composition.md §3 — the map
  // pass, the song, or the fold of the looping siblings), min Q —
  // computed by the PARENT and passed down (leaves never inspect
  // siblings). A free-length song restarts the grid at its top at
  // every depth (I5).
  const int64_t context_loop = std::max(Q, context.context_cycle);

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
  // extra machinery. There is deliberately no anticipatory-window
  // DEFERRAL: any click before a boundary already targets that
  // boundary, and a deferral would skip past the boundary when the
  // compensation is small, overshooting the take to the NEXT one.
  const int64_t target = epoch + timing::armTarget(rel, Q, context_loop);

  // HEARD-FRAME ORIGIN FOLD (Q15): when active
  // windows make the audible cycle SHORTER than the intrinsic one, the
  // heard world is exactly heard-cycle-periodic — so every boundary in
  // {target − k·heard} is AUDIBLY IDENTICAL as an anchor, differing
  // only by intrinsic phase the performer can neither hear nor see
  // (the cursor wraps on the heard cycle). Store the representative
  // that lands in the FIRST heard window of the intrinsic frame: the
  // take anchors where the cursor actually sweeps, instead of a
  // die-roll among equivalent slots. Capture still starts at the REAL boundary
  // (`target`); I1 holds exactly (playback shifts by whole heard
  // cycles); nothing else moves (no epoch change — I4). No-op in the
  // mainline (heard == intrinsic when no window is active).
  int64_t origin = target;
  {
    const int64_t heard = island->activeTakeHeardCycle();
    const int64_t intrinsic = island->activeTakeIntrinsicCycle();
    if (heard > 0 && intrinsic > heard) {
      const int64_t rel_t = timing::posMod(target - epoch, intrinsic);
      origin = target - (rel_t / heard) * heard;
    }
  }
  origin_samples.store(origin);
  origin_rt_.store(origin);
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
  // A SLOT fact: captured for the slot's FIRST take only. A new take of
  // a committed slot (retake_period_ > 0) performs against the slot's
  // existing frame, and a retake that cancels short of its period must
  // leave the standing take's cycle exactly as it was.
  celestrian::AudioNode* island = context.island;
  if (retake_period_.load() <= 0) {
    const int64_t heard = island->activeTakeHeardCycle();
    take_context_cycle_.store(heard > 0 ? heard
                                        : island->activeTakeIntrinsicCycle());
  }

  rec_state_.store((int)RecState::Capturing);
  awaiting_start_at.store(0);
  write_position.store(0);
  live_duration_samples.store(0);
  // The heard-length cap and the write base for this capture: a
  // through-map take caps at one map pass; a new take caps at the
  // slot's period and lands at the slot's shared content base.
  capture_cap_ = through_map_capture_ ? take_map_.period()
                                      : retake_period_.load();
  capture_base_ = retake_period_.load() > 0 ? content_base_.load() : 0;
  // Capture window (performance.md §3): clip position 0 holds the input
  // that ARRIVED at performance-time `target`, i.e. (target −
  // compensated) samples after this block's first arrival. A negative
  // delta (boundary just passed) reaches back into the pre-record ring.
  capture_uses_ring_ = (context.prerecord_ring != nullptr);
  capture_next_clock_ = context.input_clock + (target - compensated_pos);
  underrun_logged_ = false;
  // MIDI window (phase 5): content 0 is the note that arrives when the
  // heard clock reaches `target` — MIDI-compensated. `compensated_pos`
  // is the AUDIO-compensated clock (input + output latency behind the
  // callback clock); a MIDI arrival is only OUTPUT-latency behind it,
  // so the window sits (audio − MIDI compensation) later on the
  // arrival clock than the audio window does. Same law on the plain
  // and through-map paths (both hand in target/compensated in one
  // heard frame). Events already in the history that fall inside the
  // window are picked up (the pickup / first-clip reach-back).
  midi_capture_next_clock_ =
      capture_next_clock_ -
      context.input_latency + context.midi_latency;
  midi_history_cursor_ =
      context.midi_history ? context.midi_history->oldestSeq() : 0;
  capture_held_.clear();
  capture_prelude_.clear();
  midi_prelude_folded_ = false;
  midi_lost_logged_ = false;
}

void ClipNode::startRecording(int64_t through_map_commit_cycle) {
  if (prepareRecording(through_map_commit_cycle)) publishArm();
}

bool ClipNode::prepareRecording(int64_t through_map_commit_cycle) {
  if (recState() != RecState::Idle)
    return false;  // idempotent; keeps the
                   // island take counter exact
  reserveTakeStorage(through_map_commit_cycle);
  retake_period_.store(0);
  duration_samples.store(0);
  live_duration_samples.store(0);
  is_playing.store(false);
  return true;
}

void ClipNode::reserveTakeStorage(int64_t through_map_commit_cycle) {
  // The take's CONTENT KIND (phase 5): an instrument slot on this
  // clip's chain makes it a MIDI track — the take records notes from
  // the MIDI input, not samples from an audio input. Fixed here, before
  // the Armed store publishes it to the audio thread; the arm-time
  // reservation follows the kind. is_playing goes down first so no
  // render reads the sequence being reallocated (arm targets emptiness
  // — the same discipline the audio buffer's setSize relies on).
  is_playing.store(false);
  const bool midi_take = fxChain()->hasInstrumentSlot();
  content_kind_.store((int)(midi_take ? ContentKind::Midi : ContentKind::Audio));
  if (midi_take) {
    midi_.load()->reserve(MidiSequence::kMaxEvents);
    capture_channels_ = 1;
  }

  // VIRTUAL reservation — address space only, deliberately not
  // cleared (touching the pages would commit them; capture writes are
  // the only thing that should). Nothing ever reads past
  // write_position, so the uninitialized tail is unreachable.
  if (!midi_take) {
    // The take's channel count is fixed HERE (a stereo pair of inputs
    // captures two channels): the audio thread reads capture_channels_
    // only after observing the Armed state stored below.
    capture_channels_ = isStereoInput() ? 2 : 1;
    const int want = (int)std::min<int64_t>(
        kMaxTakeSamples, std::numeric_limits<int>::max() - 64);
    // RESERVED STORAGE (take_storage.h): the address space is reserved,
    // pages commit ahead of the write head (the engine's grower) — a
    // mic costs what it has recorded plus a headroom, on every
    // platform, and the reservation is instant. The clip is idle and
    // empty here (arm targets emptiness), so the previous content can
    // be dropped in place.
    if (take_storage_ == nullptr || take_storage_->channels() != capture_channels_ ||
        take_storage_->capacity() < want) {
      storage_rt_.store(nullptr);
      // Keep the outgoing storage alive until nothing refers to it: the
      // installed content buffer may be a REFERRING view over these
      // pages — a direct reassignment would munmap them under it.
      auto stranded = std::move(take_storage_);
      take_storage_ = TakeStorage::reserve(capture_channels_, want);
      if (take_storage_ != nullptr) {
        take_storage_->commitTo(kArmCommitSamples);
        content_owned_ = std::make_unique<juce::AudioBuffer<float>>(
            take_storage_->channelArray(), capture_channels_, want);
        content_.store(content_owned_.get());
        storage_rt_.store(take_storage_.get());
      } else {
        // The OS refused the reservation: the plain heap path. Replace
        // the (possibly referring) buffer with an OWNED allocation
        // rather than resizing a view over the stranded storage; the
        // stranded reservation then releases at scope exit.
        content_owned_ = std::make_unique<juce::AudioBuffer<float>>(
            capture_channels_, want);
        content_.store(content_owned_.get());
      }
    }
    auto& buffer = *content_.load();
    // THROUGH-MAP take (time_maps.md phase 2, ruling 2): the commit is
    // a dense [0, C) buffer with LITERAL SILENCE in unvisited regions —
    // zero exactly that span now (message thread, clip idle; an
    // audio-thread memset at commit would violate the RT contract).
    // The reservation tail past C stays uncleared (touching it would
    // commit its pages).
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
  awaiting_start_at.store(0);
  stop_requested_.store(false);
  stop_pending_gen_.store(0);
}

void ClipNode::publishArm() {
  // GROUP ARM ATOMICITY: the take-buffer reservation can cost
  // milliseconds on platforms without lazy overcommit; a group arm that
  // reserved and published per mic in one loop would let the audio
  // callback land between mics, arming them in DIFFERENT blocks —
  // different first-take origins, so the N mics would no longer be ONE
  // take (definerStack() == null: no trim view). The engine reserves
  // every member first and publishes the Armed states back-to-back
  // (one block top sees all).
  if (recState() != RecState::Idle) return;
  rec_state_.store((int)RecState::Armed);
  rootNode()->takeArmed();
}

void ClipNode::stopRecording() { stopRecording(getEffectiveQuantum() > 0); }

void ClipNode::stopRecording(bool island_has_quantum, uint32_t group_generation) {
  switch (recState()) {
    case RecState::Armed:
      // Never started capturing: stopping an armed clip is a CANCEL —
      // back to Idle with no content, never a phantom awaiting-stop.
      // A new take's cancel hands the slot back at settleRetake.
      rec_state_.store((int)RecState::Idle);
      awaiting_start_at.store(0);
      map_commit_cycle_.store(0);
      if (retake_period_.load() > 0) {
        retake_period_.store(0);
        retake_cancelled_.store(true);
      }
      rootNode()->takeCancelled();
      juce::Logger::writeToLog("ClipNode: Arm cancelled before capture");
      break;

    case RecState::Capturing:
      if (island_has_quantum) {
        // ALWAYS record forward to the next clean boundary. The boundary
        // itself is computed by the AUDIO thread at the top of its next
        // block (see control()) — computed here, from a racing write
        // position, it could already be behind the write head.
        if (group_generation != 0) {
          stop_pending_gen_.store(group_generation);  // published by the engine
        } else {
          stop_requested_.store(true);
        }
        juce::Logger::writeToLog(
            "ClipNode: Stop requested - finishing to the next boundary");
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

    // Commit fires on the AUDIO thread (from control) with the context,
    // whose island facts are the only ones it reads — or on the MESSAGE
    // thread (first-clip immediate stop) without one, where the parent
    // walks are legitimate.
    jassert(ctx == nullptr || (ctx->snap != nullptr && ctx->island != nullptr));
    celestrian::AudioNode* island = ctx ? ctx->island : rootNode();
    int64_t L = (int64_t)write_position.load();
    int64_t Q = ctx ? ctx->quantum : getEffectiveQuantum();
    int64_t duration = L;

    const int64_t map_C = through_map_capture_ ? map_commit_cycle_.load() : 0;
    const int64_t retake_P = retake_period_.load();
    if (retake_P > 0) {
      // NEW TAKE COMMIT (docs/takes.md): the slot's facts are the
      // take's facts — duration, origin, loop points and base all stand
      // (asserted by tests/takes_tests.cc); the cap chose WHEN. The
      // recorded extent covers the written region behind the shared
      // base, and the whole old extent of a collapsed slot, so
      // compaction keeps what an uncollapse would expose.
      duration = duration_samples.load();
      write_position.store((int)std::max<int64_t>(
          capture_base_ + L, collapsed_from_.load()));
      RtLog::instance().post(
          "ClipNode: New take commit - period=%lld (heard L=%lld)",
          (long long)duration, (long long)L);
    } else if (map_C > 0) {
      // THROUGH-MAP COMMIT (time_maps.md ruling 2): the take IS the
      // mapping node's full inner cycle — one dense buffer, zeroed at
      // arm, content where the mapped clock wrote, literal silence in
      // unvisited regions. Heard-time snapping already chose WHEN this
      // commit fired (stop boundary / one-period cap); C is WHAT
      // commits, so no duration snap applies.
      duration = map_C;
      setLoopPoints(0, duration);
      RtLog::instance().post(
          "ClipNode: Through-map commit - C=%lld (heard L=%lld)",
          (long long)map_C, (long long)L);
    } else if (Q > 0 && final_duration <= 0) {
      // Hysteresis snapping — shared math in timing.h.
      auto snap = timing::snapCommittedDuration(L, Q);
      duration = snap.duration;
      setLoopPoints(0, snap.loop_end);

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
      setLoopPoints(0, duration);
    } else {
      // No quantum or fallback (first clip case)
      setLoopPoints(0, duration);
    }

    // THE END SEAM (docs/vst3.md §11): a note still down when the take
    // ends is closed at its last sample, so the content owns every
    // release it needs (the seam release on playback is then a no-op
    // for it). Heard frame on a through-map take (folded like every
    // capture write), content frame otherwise; capture_* still stand.
    if (contentKind() == ContentKind::Midi && capture_held_.any()) {
      const int64_t last = through_map_capture_ ? L - 1 : duration - 1;
      float unused_peak = 0.0f;
      capture_held_.forEachHeld([&](int ch, int note, juce::uint8) {
        const juce::uint8 off[3] = {(juce::uint8)(0x80 | ch),
                                    (juce::uint8)note, 0};
        if (last >= 0) captureMidiEvent(last, off, 3, unused_peak);
      });
      capture_held_.clear();
    }

    duration_samples.store(duration);  // > 0 is what "committed" means

    // First committed clip in the island establishes Q — stored once at
    // the island root, never derived again (Q13: Q survives its
    // creator). Epoch = this clip's origin.
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
    const int64_t intrinsic_after = ctx ? snapIntrinsicDuration(*ctx->snap, 0)
                                        : island->getIntrinsicDuration();
    island->takeCommitted(origin, intrinsic_after);

    // §2.3: the commit block renders silent (see render()); playback
    // begins on the next block.
    committed_this_block_.store(true);

    // Through-map take state ends with the take.
    map_commit_cycle_.store(0);
    through_map_capture_ = false;
    take_map_ = timing::TimeMap::none();
    map_anchor_off_ = 0;
    capture_cap_ = 0;
    capture_base_ = 0;
    // A new take's list append is a message-thread act: flag it for
    // settleRetake (the clip already sounds the new content).
    if (retake_P > 0) {
      retake_period_.store(0);
      retake_committed_.store(true);
    }
  }
}

void ClipNode::startPlayback() {
  if (duration_samples.load() > 0) {
    is_playing.store(true);
  }
}

juce::var ClipNode::getWaveform(int num_peaks) const {
  // The message thread may read clip content ONLY in Idle. A non-Idle
  // clip has no committed content to draw (no-overdub), and the UI
  // synthesizes its live picture from currentPeak. The state load is
  // the publication point: commit stores Idle (seq-cst) after every
  // capture write, so observing Idle here orders those writes before
  // our reads — and only the message thread arms, so Idle cannot flip
  // to Capturing under us. (A mid-take read bounded by write_position
  // would not be safe: the through-map fold scatters destinations
  // across [0, C) while write_position counts HEARD samples, so a
  // bounded read could overlap an in-flight captureWrite.)
  if (recState() != RecState::Idle) return juce::Array<juce::var>();
  int total_samples = (int)duration_samples;
  if (total_samples <= 0) total_samples = write_position.load();
  if (total_samples <= 0) return juce::Array<juce::var>();
  // Content base (Q13 lock-collapse): peaks cover the COMMITTED content
  // [base, base + duration) — the cut material never renders.
  const int64_t base = content_base_.load();
  if (contentKind() == ContentKind::Midi) {
    return midiPeaks(*midi_.load(), base, total_samples, num_peaks);
  }
  return audioPeaks(*content_.load(), base, total_samples, num_peaks);
}

juce::var ClipNode::getTakeWaveform(int k, int num_peaks) const {
  // The take-list view (docs/takes.md): take k over the committed span,
  // read on the message thread while Idle like getWaveform.
  if (recState() != RecState::Idle) return juce::Array<juce::var>();
  if (k < 0 || k >= takeCount()) return juce::Array<juce::var>();
  if (k == activeTake()) return getWaveform(num_peaks);
  const int total_samples = (int)duration_samples.load();
  if (total_samples <= 0) return juce::Array<juce::var>();
  const int64_t base = content_base_.load();
  const TakeState& s = takes_[(size_t)k];
  if (s.content_kind == (int)ContentKind::Midi && s.midi != nullptr) {
    return midiPeaks(*s.midi, base, total_samples, num_peaks);
  }
  if (s.buffer == nullptr) return juce::Array<juce::var>();
  return audioPeaks(*s.buffer, base, total_samples, num_peaks);
}

juce::var ClipNode::midiPeaks(const MidiSequence& seq, int64_t base,
                              int total_samples, int num_peaks) {
  // A MIDI take draws as a VELOCITY ENVELOPE in the same peak lane:
  // each window's value is the loudest note sounding in it (held
  // notes sustain their velocity, releases drop it) — note bars, in
  // the renderer the audio lanes already use. Events before the
  // content base only prime the held state.
  juce::Array<juce::var> peaks;
  const int window_size = std::max(1, total_samples / std::max(1, num_peaks));
  std::array<juce::uint8, 128> held{};
  held.fill(0);
  int cursor = 0;
  auto step = [&](int64_t until, int& cur) {
    while (cursor < seq.count() && seq[cursor].pos < until) {
      const MidiEvent& e = seq[cursor++];
      if (e.isNoteOn()) {
        held[(size_t)e.note()] = (juce::uint8)e.velocity();
        cur = std::max(cur, e.velocity());
      } else if (e.isNoteOff()) {
        held[(size_t)e.note()] = 0;
      }
    }
  };
  int dummy = 0;
  step(base, dummy);
  for (int i = 0; i < num_peaks; ++i) {
    const int64_t start = base + (int64_t)i * window_size;
    const int64_t end = std::max(
        start + 1,
        std::min(start + window_size, base + (int64_t)total_samples));
    int cur = 0;
    for (const auto v : held) cur = std::max(cur, (int)v);
    if (start < base + total_samples) step(end, cur);
    peaks.add((float)cur / 127.0f);
  }
  return peaks;
}

juce::var ClipNode::audioPeaks(const juce::AudioBuffer<float>& buffer,
                               int64_t base, int total_samples,
                               int num_peaks) {
  juce::Array<juce::var> peaks;
  const int window_size = std::max(1, total_samples / std::max(1, num_peaks));
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

// ===================================================================
// The take list and the comp (docs/takes.md). Message thread unless
// stated; the audio thread sees only the seqlocked take table.
// ===================================================================

void ClipNode::readCompView(CompView& v) const {
  take_lock_.read([&] {
    v.n = comp_n_.load(std::memory_order_relaxed);
    v.q = comp_q_.load(std::memory_order_relaxed);
    v.count = take_table_count_.load(std::memory_order_relaxed);
    v.active = active_take_.load(std::memory_order_relaxed);
    for (int i = 0; i < kMaxCompCells; ++i) {
      v.cells[i] = comp_cells_[i].load(std::memory_order_relaxed);
    }
    for (int i = 0; i < kMaxTakes; ++i) {
      v.buffers[i] = take_buffers_[i].load(std::memory_order_relaxed);
    }
  });
  if (v.n < 0 || v.n > kMaxCompCells) v.n = 0;
  if (v.count < 0 || v.count > kMaxTakes) v.count = 0;
}

void ClipNode::publishTakeTable() {
  take_lock_.write([&] {
    const int n = std::min<int>(kMaxTakes, (int)takes_.size());
    take_table_count_.store(n, std::memory_order_relaxed);
    for (int i = 0; i < kMaxTakes; ++i) {
      const juce::AudioBuffer<float>* b =
          i < n ? takes_[(size_t)i].buffer.get() : nullptr;
      take_buffers_[i].store(b, std::memory_order_relaxed);
    }
  });
}

void ClipNode::setCompCells(const std::vector<int>& cells, int64_t cell_len) {
  const int n = std::min<int>(kMaxCompCells, (int)cells.size());
  take_lock_.write([&] {
    comp_n_.store(cell_len > 0 ? n : 0, std::memory_order_relaxed);
    comp_q_.store(cell_len, std::memory_order_relaxed);
    for (int i = 0; i < kMaxCompCells; ++i) {
      const int c = i < n ? cells[(size_t)i] : -1;
      comp_cells_[i].store((int8_t)std::clamp(c, -1, kMaxTakes - 1),
                           std::memory_order_relaxed);
    }
  });
}

std::vector<int> ClipNode::compCells() const {
  std::vector<int> out;
  const int n = std::clamp(comp_n_.load(), 0, kMaxCompCells);
  out.reserve((size_t)n);
  for (int i = 0; i < n; ++i) out.push_back(comp_cells_[i].load());
  return out;
}

void ClipNode::ensureTakeList() {
  if (takes_.empty()) {
    takes_.emplace_back();  // the active slot, empty
    active_take_.store(0);
  }
}

void ClipNode::stashLive(TakeState& slot) {
  slot.buffer = std::move(content_owned_);
  slot.storage = releaseStorage();
  slot.midi = std::move(midi_owned_);
  slot.recorded = write_position.load();
  slot.cap_hit = cap_hit_.load();
  slot.content_kind = content_kind_.load();
  slot.base = content_base_.load();
  slot.origin = origin_samples.load();
  slot.duration = duration_samples.load();
  slot.context_cycle = take_context_cycle_.load();
}

void ClipNode::adoptSlot(TakeState& slot) {
  content_owned_ = std::move(slot.buffer);
  take_storage_ = std::move(slot.storage);
  storage_rt_.store(take_storage_.get());
  midi_owned_ = std::move(slot.midi);
  if (midi_owned_ == nullptr) midi_owned_ = std::make_unique<MidiSequence>(0);
  content_kind_.store(slot.content_kind);
  write_position.store((int)slot.recorded);
  cap_hit_.store(slot.cap_hit);
  // The atomic swaps: an in-flight render finishes on the old pointers,
  // which live on in the list.
  midi_.store(midi_owned_.get());
  content_.store(content_owned_.get());
}

const juce::AudioBuffer<float>* ClipNode::takeBuffer(int k) const {
  if (k < 0 || k >= takeCount()) return nullptr;
  if (k == activeTake()) return content_.load();
  return takes_[(size_t)k].buffer.get();
}

const MidiSequence* ClipNode::takeMidi(int k) const {
  if (k < 0 || k >= takeCount()) return nullptr;
  if (k == activeTake()) return midi_.load();
  return takes_[(size_t)k].midi.get();
}

int64_t ClipNode::takeRecorded(int k) const {
  if (k < 0 || k >= takeCount()) return 0;
  if (k == activeTake()) return write_position.load();
  return takes_[(size_t)k].recorded;
}

bool ClipNode::selectTake(int k) {
  if (recState() != RecState::Idle) return false;
  if (k < 0 || k >= takeCount() || k == activeTake()) return false;
  ensureTakeList();
  TakeState& in = takes_[(size_t)k];
  if (in.buffer == nullptr) return false;
  stashLive(takes_[(size_t)activeTake()]);
  adoptSlot(in);
  active_take_.store(k);
  publishTakeTable();
  return true;
}

ClipNode::TakeState ClipNode::removeTake(int k) {
  TakeState out;
  if (recState() != RecState::Idle || takeCount() < 2) return out;
  if (k < 0 || k >= takeCount()) return out;
  ensureTakeList();
  if (k == activeTake()) selectTake(k > 0 ? k - 1 : 1);
  out = std::move(takes_[(size_t)k]);
  takes_.erase(takes_.begin() + k);
  if (activeTake() > k) active_take_.store(activeTake() - 1);
  take_files_dirty_ = true;
  // The table drops the pointer BEFORE the caller may retire the record.
  publishTakeTable();
  return out;
}

void ClipNode::insertTake(int k, TakeState&& s) {
  if (recState() != RecState::Idle) return;
  ensureTakeList();
  k = std::clamp<int>(k, 0, (int)takes_.size());
  takes_.insert(takes_.begin() + k, std::move(s));
  if (activeTake() >= k) active_take_.store(activeTake() + 1);
  take_files_dirty_ = true;
  publishTakeTable();
}

void ClipNode::appendLoadedTake(const juce::AudioBuffer<float>& audio) {
  ensureTakeList();
  TakeState s;
  const int n = audio.getNumSamples();
  const int chans = std::max(1, audio.getNumChannels());
  s.buffer = std::make_unique<juce::AudioBuffer<float>>(chans, std::max(1, n));
  s.buffer->clear();
  for (int c = 0; c < chans && n > 0; ++c) s.buffer->copyFrom(c, 0, audio, c, 0, n);
  s.midi = std::make_unique<MidiSequence>(0);
  s.recorded = n;
  s.content_kind = (int)ContentKind::Audio;
  s.origin = origin_samples.load();
  s.duration = duration_samples.load();
  takes_.push_back(std::move(s));
  publishTakeTable();
}

void ClipNode::appendLoadedMidiTake(std::vector<MidiEvent> events) {
  ensureTakeList();
  TakeState s;
  s.buffer = std::make_unique<juce::AudioBuffer<float>>(1, 1);
  s.buffer->clear();
  s.midi = std::make_unique<MidiSequence>();
  s.midi->assign(std::move(events));
  s.recorded = duration_samples.load();
  s.content_kind = (int)ContentKind::Midi;
  s.origin = origin_samples.load();
  s.duration = duration_samples.load();
  takes_.push_back(std::move(s));
  publishTakeTable();
}

bool ClipNode::prepareRetake() {
  if (recState() != RecState::Idle || duration_samples.load() <= 0) return false;
  if (takeCount() >= kMaxTakes) return false;
  // One kind per slot: the next take's kind is decided by the chain
  // (an instrument slot records notes); it must match what the slot
  // already holds, or the list could not be saved as one clip.
  const bool next_midi = fxChain()->hasInstrumentSlot();
  if (next_midi != (contentKind() == ContentKind::Midi)) return false;
  const int64_t period = duration_samples.load();
  // Silence first (render gates on is_playing), then park the active
  // content in its list slot — its buffer stays alive there, so the
  // render still in flight on content_ reads valid memory.
  is_playing.store(false);
  ensureTakeList();
  stashLive(takes_[(size_t)activeTake()]);
  content_owned_ =
      std::make_unique<juce::AudioBuffer<float>>(1, std::max(1, (int)sample_rate));
  content_owned_->clear();
  midi_owned_ = std::make_unique<MidiSequence>(0);
  midi_.store(midi_owned_.get());
  content_.store(content_owned_.get());
  publishTakeTable();
  reserveTakeStorage(0);
  // The new take lands at the shared base: zero everything an
  // uncollapse could later expose — [0, base) ahead of it and the old
  // extent of a collapsed slot — so no uninitialized page ever renders.
  if (!next_midi) {
    auto& buffer = *content_.load();
    const int64_t clear_to = std::min<int64_t>(
        buffer.getNumSamples(),
        std::max<int64_t>(content_base_.load() + period, collapsed_from_.load()));
    for (int c = 0; c < buffer.getNumChannels(); ++c) {
      buffer.clear(c, 0, (int)clear_to);
    }
  }
  retake_committed_.store(false);
  retake_cancelled_.store(false);
  live_duration_samples.store(0);
  retake_period_.store(period);
  return true;
}

bool ClipNode::settleRetake(TakeState& displaced) {
  if (retake_committed_.load()) {
    retake_committed_.store(false);
    ensureTakeList();
    takes_.emplace_back();  // the new active slot, empty (content is live)
    active_take_.store((int)takes_.size() - 1);
    publishTakeTable();
    return true;
  }
  if (retake_cancelled_.load()) {
    retake_cancelled_.store(false);
    ensureTakeList();
    // The abandoned reservation goes to the caller; the previous active
    // take comes back from its slot and sounds again.
    displaced.buffer = std::move(content_owned_);
    displaced.storage = releaseStorage();
    displaced.midi = std::move(midi_owned_);
    adoptSlot(takes_[(size_t)activeTake()]);
    live_duration_samples.store(duration_samples.load());
    publishTakeTable();
    is_playing.store(true);
  }
  return false;
}

namespace {
/** The splice copy shared by the active and inactive takes: `m`'s
 * segments of `src` (read behind `base`) concatenated into an exact
 * `period`-sized buffer (a MIDI take keeps the one-sample baseline). */
std::unique_ptr<juce::AudioBuffer<float>> spliceBuffer(
    const juce::AudioBuffer<float>& src, int64_t base,
    const timing::TimeMap& m, bool midi) {
  const int64_t period = m.period();
  const int chans = std::max(1, src.getNumChannels());
  auto spliced = std::make_unique<juce::AudioBuffer<float>>(
      chans, midi ? 1 : (int)period);
  spliced->clear();
  int64_t w = 0;
  for (int i = 0; i < (midi ? 0 : m.n); ++i) {
    const int64_t s = m.segs[i].start;
    const int64_t len = m.segs[i].end - s;
    const int64_t from = base + s;
    const int64_t avail = std::max<int64_t>(
        0, std::min<int64_t>(len, src.getNumSamples() - from));
    if (avail > 0) {
      for (int c = 0; c < chans; ++c) {
        spliced->copyFrom(c, (int)w, src, c, (int)from, (int)avail);
      }
    }
    w += len;
  }
  return spliced;
}
/** The note twin: events inside the kept cells move to their spliced
 * positions; the rest are cut. */
std::unique_ptr<MidiSequence> spliceSequence(const MidiSequence& src,
                                             int64_t base,
                                             const timing::TimeMap& m) {
  std::vector<MidiEvent> kept;
  kept.reserve((size_t)src.count());
  int64_t w = 0;
  for (int i = 0; i < m.n; ++i) {
    const int64_t s = m.segs[i].start;
    const int64_t len = m.segs[i].end - s;
    for (int k = 0; k < src.count(); ++k) {
      const int64_t rel = src[k].pos - base - s;
      if (rel >= 0 && rel < len) {
        MidiEvent e = src[k];
        e.pos = w + rel;
        kept.push_back(e);
      }
    }
    w += len;
  }
  auto spliced = std::make_unique<MidiSequence>();
  spliced->assign(std::move(kept));
  return spliced;
}
}  // namespace

std::vector<std::pair<int, ClipNode::TakeState>>
ClipNode::spliceOtherTakesToMap(const timing::TimeMap& m) {
  std::vector<std::pair<int, TakeState>> old;
  const int64_t base = content_base_.load();
  for (int k = 0; k < (int)takes_.size(); ++k) {
    TakeState& s = takes_[(size_t)k];
    if (k == activeTake() || s.buffer == nullptr) continue;
    const bool midi = s.content_kind == (int)ContentKind::Midi;
    TakeState fresh;
    fresh.buffer = spliceBuffer(*s.buffer, base, m, midi);
    fresh.midi = midi && s.midi ? spliceSequence(*s.midi, base, m)
                                : std::make_unique<MidiSequence>(0);
    fresh.recorded = m.period();
    fresh.content_kind = s.content_kind;
    fresh.cap_hit = s.cap_hit;
    fresh.origin = s.origin;
    fresh.duration = m.period();
    fresh.base = 0;
    old.emplace_back(k, std::move(s));
    s = std::move(fresh);
  }
  if (!old.empty()) publishTakeTable();
  return old;
}

std::vector<ClipNode::TakeState> ClipNode::unspliceOtherTakes(
    std::vector<std::pair<int, TakeState>>&& old) {
  std::vector<TakeState> displaced;
  for (auto& [k, s] : old) {
    if (k < 0 || k >= (int)takes_.size() || k == activeTake()) continue;
    displaced.push_back(std::move(takes_[(size_t)k]));
    takes_[(size_t)k] = std::move(s);
  }
  if (!displaced.empty()) publishTakeTable();
  return displaced;
}

}  // namespace celestrian
