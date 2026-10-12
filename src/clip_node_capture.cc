// ClipNode — the recording state machine (ClipNode::RecState): the arm
// and its storage (message thread), then, on the audio thread, the arm
// target, capture from the pre-record ring / the MIDI history with
// latency compensation, the wall guard, the stop boundary and the
// commit. control() is the audio-thread entry: no locks, no heap; its
// log lines go through RtLog.

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>
#include <limits>

#include "clip_node.h"
#include "rt_log.h"
#include "timing.h"

namespace celestrian {

void ClipNode::control(const float* const* input_channels,
                       int num_input_channels, const ProcessContext& context) {
  jassert(context.snap != nullptr && context.island != nullptr);
  // Last block's commit has rendered its one silent block.
  committed_this_block_.store(false);
  adoptOriginGate(context);
  // A device-stop request becomes this block's edge: render only sends
  // what control decided.
  if (midi_sound_off_pending_.exchange(false)) midi_sound_off_due_ = true;

  // Armed: choose the target, and start capturing once it is reached —
  // possibly within this block.
  if (recState() == RecState::Armed) armEvaluate(context);
  if (consumeStopRequest(context)) return;  // the take ended at this top
  if (!isRecording()) return;
  if (contentKind() == ContentKind::Midi) {
    captureMidiBlock(context);
    return;
  }
  if (wallGuard(context)) return;  // committed at the wall
  captureAudioBlock(context, input_channels, num_input_channels);
}

bool ClipNode::consumeStopRequest(const ProcessContext& context) {
  if (recState() != RecState::Capturing) return false;
  // A parked group stop becomes a request at the first block top whose
  // context carries its generation: every member sees it in one block.
  if (!stop_requested_.load()) {
    const uint32_t pending = stop_pending_gen_.load();
    if (pending != 0 && context.stop_generation >= pending) {
      stop_requested_.store(true);
      stop_pending_gen_.store(0);
    }
  }
  if (!stop_requested_.load()) return false;

  if (retake_period_.load() > 0) {
    // A NEW TAKE stopped short (takes.md): nothing shorter than the
    // period is a take of this slot, so the stop cancels it, in the
    // end-of-take order (RecState). The previous take comes back at
    // settleRetake; the clip stays silent until then.
    stop_requested_.store(false);
    retake_period_.store(0);
    retake_cancelled_.store(true);
    rec_state_.store((int)RecState::Idle);
    context.island->takeCancelled();
    RtLog::instance().post(
        "ClipNode: new take cancelled before its period (L=%lld) - the "
        "previous take stands",
        (long long)write_position.load());
    return true;
  }
  const int64_t Q = context.quantum;
  if (Q <= 0) {
    // THE ISLAND'S FIRST TAKE has no boundary to finish at: it ends HERE,
    // at the write head — every sample the take holds, none of this
    // block's. Every member of a first-take group reads the block's Q
    // (0) and the one stop generation, so they all end at this top.
    commitRecording(context);
    // Nothing of this block was captured: the block plays, from the take
    // the commit just published.
    committed_this_block_.store(false);
    return true;
  }
  // The boundary is chosen HERE, from the audio thread's own write head:
  // one computed on the message thread could already lie behind it.
  int64_t boundary = timing::nextStopBoundary(write_position.load(), Q);
  // A through-map take never passes one map pass.
  if (through_map_capture_) boundary = std::min(boundary, take_map_.period());
  awaiting_stop_at.store(boundary);
  rec_state_.store((int)RecState::PendingStop);
  RtLog::instance().post("ClipNode: PendingStop at B=%lld (L=%lld)",
                         (long long)boundary, (long long)write_position.load());
  stop_requested_.store(false);
  return false;
}

bool ClipNode::wallGuard(const ProcessContext& context) {
  if (recState() != RecState::Capturing || stop_requested_.load()) return false;
  // `room` is what the head may still write (writableCapacity). The
  // grower commits the take's reach ahead of it (takeReach), so the head
  // comes this close only when the message thread stalled for
  // kArmCommitSamples of capture, or at the end of the reservation.
  const int64_t wp = write_position.load();
  const int64_t room = writableCapacity() - capture_base_ - wp;
  if (const int64_t Q = context.quantum; Q > 0) {
    // What a stop asked for now would still write: the stop run, or the
    // rest of the take's cap when that is nearer.
    int64_t stop_needs = stopRun(Q);
    if (capture_cap_ > 0) stop_needs = std::min(stop_needs, capture_cap_ - wp);
    if (room < stop_needs) {
      stop_requested_.store(true);
      cap_hit_.store(true);
      RtLog::instance().post(
          "ClipNode: take reached the reservation bound - finishing "
          "at the last clean boundary");
    }
    return false;
  }
  if (room > context.num_samples) return false;
  // The island's first take has no boundary to finish at: it commits
  // what it has written.
  cap_hit_.store(true);
  RtLog::instance().post(
      "ClipNode: first take reached the reservation bound - "
      "committed at %lld samples",
      (long long)wp);
  commitRecording(context);
  return true;
}

void ClipNode::captureAudioBlock(const ProcessContext& context,
                                 const float* const* input_channels,
                                 int num_input_channels) {
  // One content load per pass: the pointer is never swapped mid-capture.
  juce::AudioBuffer<float>& buffer = *content_.load();
  const int64_t wp = write_position.load();
  // One content channel per assigned input; the count was fixed at arm.
  const int channels = std::min(capture_channels_, buffer.getNumChannels());
  float peak = 0.0f;
  // One span of one captured channel: into the take and into the meter.
  // The SOURCE is metered — the take, not the device, and a through-map
  // fold scatters the destinations.
  const auto take = [&](int c, const float* src, int64_t heard_pos,
                        int count) {
    captureWrite(buffer, c, heard_pos, src, count);
    for (int i = 0; i < count; ++i) peak = std::max(peak, std::abs(src[i]));
  };

  if (capture_uses_ring_ && context.prerecord_ring != nullptr &&
      context.prerecord_ring_channels > 0) {
    // ARRIVAL-TIME CAPTURE (performance.md §3): content position p holds
    // the input that arrived at capture_next_clock_ + p. The window start
    // carries the latency compensation, so a note played on the HEARD
    // beat lands on the beat in the take.
    const int64_t available_end = context.input_clock + context.num_samples;
    const int ring_len = context.prerecord_ring_len;
    const int64_t oldest = std::max<int64_t>(0, available_end - ring_len);
    int64_t src = capture_next_clock_;
    if (src < oldest) {
      // One line per capture: an underrun that persists would otherwise
      // post every block and keep the drain FIFO full.
      if (!underrun_logged_) {
        underrun_logged_ = true;
        RtLog::instance().post(
            "ClipNode: pre-record ring underrun, %lld samples lost",
            (long long)(oldest - src));
      }
      src = oldest;
    }
    if (src >= available_end) return;  // the window is not reached yet
    const int n =
        (int)std::min<int64_t>(available_end - src, captureSpace(wp));
    if (n <= 0) return;
    const RingSpan span = ringSpan(src, n, ring_len);
    for (int c = 0; c < channels; ++c) {
      const float* ring =
          context.prerecord_ring[inputFor(c, context.prerecord_ring_channels)];
      take(c, ring + span.idx, wp, span.first);
      if (n > span.first) take(c, ring, wp + span.first, n - span.first);
    }
    capture_next_clock_ = src + n;
    finishCaptureBlock(n, peak, context);
    return;
  }

  // No ring (node-level tests): the live block, uncompensated — or no
  // source at all. A full buffer writes nothing: the wall guard has
  // already asked for the finish.
  const int n = (int)std::min<int64_t>(context.num_samples, captureSpace(wp));
  if (n <= 0) return;
  if (input_channels != nullptr && num_input_channels > 0) {
    for (int c = 0; c < channels; ++c) {
      const float* in = input_channels[inputFor(c, num_input_channels)];
      if (in == nullptr) continue;  // the device delivered a null channel
      take(c, in, wp, n);
    }
  } else {
    // NO SOURCE (a device with no inputs, or its inputs gone mid-take):
    // the take runs by the clock over silence, so its stop boundary and
    // its cap arrive like any other take's. A plain take's span is
    // written as zeros — its reservation is never cleared; a through-map
    // take and a new take were zeroed at arm.
    if (!through_map_capture_ && retake_period_.load() <= 0) {
      for (int c = 0; c < buffer.getNumChannels(); ++c) {
        buffer.clear(c, (int)(capture_base_ + wp), n);
      }
    }
    capture_next_clock_ += n;
  }
  finishCaptureBlock(n, peak, context);
}

void ClipNode::finishCaptureBlock(int written, float block_peak,
                                  const ProcessContext& context) {
  last_block_peak.store(block_peak);

  const int64_t start_position = write_position.load();
  const int64_t end_position = start_position + written;
  write_position.store(end_position);
  live_duration_samples.store(end_position);

  if (recState() == RecState::PendingStop) {
    const int64_t target = awaiting_stop_at.load();
    if (start_position < target && end_position >= target) {
      commitRecording(context, target);
      return;
    }
  }
  // The cap is a boundary: a full map pass, or a new take's full period,
  // commits the take.
  if (capture_cap_ > 0 && end_position >= capture_cap_) {
    RtLog::instance().post(
        "ClipNode: take completed its cap (%lld samples) - committing",
        (long long)capture_cap_);
    commitRecording(context);
  }
}

void ClipNode::captureWrite(juce::AudioBuffer<float>& buffer, int dest_ch,
                            int64_t heard_pos, const float* src, int n) {
  if (!through_map_capture_) {
    const int64_t dest = capture_base_ + heard_pos;
    if (const int fit = writableRun(dest, n); fit > 0) {
      buffer.copyFrom(dest_ch, (int)dest, src, fit);
    }
    return;
  }
  // THE THROUGH-MAP FOLD (time_maps.md §3): content lands at the inner
  // positions the performance was heard against, inside the dense [0, C)
  // span. Each map seam jumps the write cursor — at most the map's
  // segment count per pass, allocation-free. heard_pos < period by the
  // one-pass cap.
  const int64_t C = map_commit_cycle_.load();
  int64_t pos = heard_pos;
  while (n > 0) {
    const int64_t seam = take_map_.seamDistance(map_anchor_off_ + pos);
    const int run = (int)std::min<int64_t>(n, seam > 0 ? seam : n);
    const int64_t dest =
        timing::throughMapDest(pos, map_anchor_off_, take_map_, C);
    if (const int fit = writableRun(dest, run); fit > 0) {
      buffer.copyFrom(dest_ch, (int)dest, src, fit);
    }
    pos += run;
    src += run;
    n -= run;
  }
}

int ClipNode::inputFor(int side, int channels) const {
  if (channels <= 0) return -1;
  const int left = preferred_input_channel.load();
  const int right = preferred_input_channel_right.load();
  return std::clamp(side == 1 && right >= 0 ? right : left, 0, channels - 1);
}

int64_t ClipNode::takeReach(int64_t quantum) const {
  const int64_t base = captureBase();
  int64_t reach = map_commit_cycle_.load();
  if (const int64_t period = retake_period_.load(); period > 0) {
    reach = std::max({reach, base + period, collapsed_from_.load()});
  }
  return std::max(reach, base + write_position.load() + stopRun(quantum) +
                             kArmCommitSamples);
}

void ClipNode::commitTakeReach(int64_t quantum) {
  // A MIDI take writes notes, not samples: a reservation an earlier
  // audio arm left behind is not its to commit.
  if (take_storage_ == nullptr || contentKind() == ContentKind::Midi) return;
  take_storage_->commitTo(takeReach(quantum));
}

int64_t ClipNode::writableCapacity() const {
  const int64_t cap = content_.load()->getNumSamples();
  if (const TakeStorage* st = storage_rt_.load()) {
    return std::min(cap, st->committed());
  }
  return cap;
}

int64_t ClipNode::captureSpace(int64_t wp) const {
  // A MIDI take writes no samples: its bound is the reservation's own.
  int64_t space = contentKind() == ContentKind::Midi
                      ? kMaxTakeSamples - wp
                      : writableCapacity() - capture_base_ - wp;
  if (capture_cap_ > 0) space = std::min(space, capture_cap_ - wp);
  return space;
}

int ClipNode::writableRun(int64_t start, int64_t n) const {
  if (n <= 0) return 0;
  const int64_t fit = std::clamp<int64_t>(writableCapacity() - start, 0, n);
  if (fit < n) TakeStorage::cut_writes.fetch_add(1, std::memory_order_relaxed);
  return (int)fit;
}

void ClipNode::clearTakeSpan(int64_t end) {
  auto& buffer = *content_.load();
  const int n = writableRun(0, end);
  for (int c = 0; c < buffer.getNumChannels(); ++c) buffer.clear(c, 0, n);
}

void ClipNode::captureMidiBlock(const ProcessContext& context) {
  const int64_t wp = write_position.load();
  const int64_t space = captureSpace(wp);
  float block_peak = 0.0f;
  // The meter reads velocity: note-ons peak it (captureMidiEvent), held
  // notes sustain it, releases let it fall.
  const auto finish = [&](int n) {
    if (block_peak <= 0.0f && capture_held_.any()) {
      block_peak = last_block_peak.load();
    }
    finishCaptureBlock(n, block_peak, context);
  };

  if (context.midi_history == nullptr) {
    // No history (node-level tests): the block's events at their
    // offsets, uncompensated.
    const int n = (int)std::min<int64_t>(context.num_samples, space);
    if (n <= 0) return;
    if (context.live_midi != nullptr) {
      for (const auto metadata : *context.live_midi) {
        if (metadata.samplePosition >= n) break;
        captureMidiEvent(wp + std::max(0, metadata.samplePosition),
                         metadata.data, metadata.numBytes, block_peak);
      }
    }
    finish(n);
    return;
  }

  // ARRIVAL-TIME CAPTURE, the note twin of the ring path
  // (captureAudioBlock): content position wp is arrival index
  // midi_capture_next_clock_, and the write head advances by heard
  // samples exactly as an audio take's does.
  const MidiHistory& hist = *context.midi_history;
  const int64_t available_end = context.input_clock + context.num_samples;
  const int64_t src = midi_capture_next_clock_;
  if (src >= available_end) return;  // the window is not reached yet
  const int n = (int)std::min<int64_t>(available_end - src, space);
  if (n <= 0) return;
  if (midi_history_cursor_ < hist.oldestSeq()) {
    // The ring overwrote entries this take had not read: one log line.
    if (!midi_lost_logged_) {
      midi_lost_logged_ = true;
      RtLog::instance().post(
          "ClipNode: MIDI history overrun, %lld events lost",
          (long long)(hist.oldestSeq() - midi_history_cursor_));
    }
    midi_history_cursor_ = hist.oldestSeq();
  }
  // THE PRELUDE: a note struck before the window and still down when it
  // opens is sounding at the take's top, so it lands as a note-on at
  // content 0 — folded once, ahead of any in-window event, so a release
  // at exactly content 0 still follows its note-on.
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
    if (e.arrival < src) {  // precedes the take: it only primes the prelude
      capture_prelude_.track(e.bytes, e.size);
      continue;
    }
    foldPrelude();
    captureMidiEvent(wp + (e.arrival - src), e.bytes, e.size, block_peak);
  }
  foldPrelude();
  midi_capture_next_clock_ = src + n;
  finish(n);
}

void ClipNode::captureMidiEvent(int64_t pos, const juce::uint8* bytes,
                                int size, float& block_peak) {
  if (pos < 0 || size <= 0 || size > 3) return;
  if (capture_cap_ > 0 && pos >= capture_cap_) return;  // beyond the cap
  // The point form of captureWrite: linear behind the capture base, or
  // folded through the take's map.
  const int64_t dest =
      through_map_capture_
          ? timing::throughMapDest(pos, map_anchor_off_, take_map_,
                                   map_commit_cycle_.load())
          : capture_base_ + pos;
  if (!midi_.load()->append(dest, bytes, size) && !midi_full_logged_) {
    midi_full_logged_ = true;
    RtLog::instance().post(
        "ClipNode: MIDI take is full (%d events) - later events are dropped",
        MidiSequence::kMaxEvents);
  }
  if (capture_held_.track(bytes, size) && (bytes[0] & 0xF0) == 0x90 &&
      bytes[2] > 0) {
    block_peak = std::max(block_peak, (float)bytes[2] / 127.0f);
  }
}

void ClipNode::armEvaluate(const ProcessContext& context) {
  const int64_t Q = context.quantum;

  // The performer plays against what they HEARD: the heard clock is the
  // received one less the round trip (ProcessContext::input_latency).
  const int64_t compensated_pos =
      std::max<int64_t>(0, context.master_pos - context.input_latency);

  // A NEW TAKE (takes.md): the slot has an origin and a period, so the
  // target is its own next top in the heard frame — the first t at or
  // past the heard clock with t ≡ origin (mod period). The origin may
  // lie AHEAD of the clock (a backward seek moves every origin with the
  // zero). Judged first: a committed slot is never pre-Q.
  if (const int64_t period = retake_period_.load(); period > 0) {
    const int64_t target =
        compensated_pos +
        timing::posMod(origin_samples.load() - compensated_pos, period);
    awaiting_start_at.store(target);
    if (armReached(compensated_pos, context.master_pos, context.num_samples,
                   target)) {
      beginCapture(context, target, compensated_pos);
      RtLog::instance().post("ClipNode: New take started (slot top %lld)",
                             (long long)target);
    }
    return;
  }

  if (Q <= 0) {
    // THE ISLAND'S FIRST TAKE starts now, and this moment is the island
    // zero: stored provisionally at the root here, with Q at commit. The
    // clock itself is never reset (kernel.md).
    origin_samples.store(compensated_pos);
    origin_rt_.store(compensated_pos);
    context.island->establishIsland(0, compensated_pos);
    beginCapture(context, compensated_pos, compensated_pos);
    RtLog::instance().post(
        "ClipNode: Recording Started at master_pos=%lld (first clip)",
        (long long)compensated_pos);
    return;
  }

  // A THROUGH-MAP ARM (time_maps.md §3): an enclosing ACTIVE map shapes
  // the take. The arm math runs in HEARD time on the map period's grid,
  // anchored at the map's heard top, and the chosen boundary maps to an
  // inner-time origin. The trigger clock is the INVARIANT island clock:
  // the received one wraps every map period and never crosses a target
  // at or past the map's end.
  if (map_commit_cycle_.load() > 0 && context.map.active()) {
    const int64_t period = context.map.period();
    // Either may be negative (the clock behind the zero, or behind the
    // map's heard top): armTarget answers on the grid either way.
    const int64_t heard = context.island_pos - context.input_latency;
    const int64_t t_rel =
        timing::armTarget(heard - context.map_heard_top, Q, period);
    const int64_t heard_target = context.map_heard_top + t_rel;
    // The map's inner positions are offsets from the mapping stack's
    // origin (ProcessContext::map_origin).
    const int64_t origin = context.map_origin + context.map.mapOffset(t_rel);
    origin_samples.store(origin);
    origin_rt_.store(origin);
    awaiting_start_at.store(heard_target);
    if (armReached(heard, context.island_pos, context.num_samples,
                   heard_target)) {
      // The take's map facts freeze before capture begins.
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

  // A PLAIN ARM: the next boundary of the loop the performer hears — the
  // scope's cycle, handed down by the parent (ProcessContext::
  // context_cycle), at least Q — in the island frame, measured from the
  // invariant zero (timing::armTarget; a click shortly before a boundary
  // compensates back onto it). The target IS the origin: the take
  // anchors at the boundary it was captured from, never folded by heard
  // cycles. Stored every block while Armed; it converges on the boundary.
  const int64_t zero = context.island_zero;
  const int64_t target =
      zero + timing::armTarget(compensated_pos - zero, Q,
                               std::max(Q, context.context_cycle));
  origin_samples.store(target);
  origin_rt_.store(target);
  awaiting_start_at.store(target);
  if (armReached(compensated_pos, context.master_pos, context.num_samples,
                 target)) {
    beginCapture(context, target, compensated_pos);
    RtLog::instance().post("ClipNode: Recording Started (Q boundary %lld)",
                           (long long)target);
  }
}

void ClipNode::beginCapture(const ProcessContext& context, int64_t target,
                            int64_t compensated_pos) {
  // The take's heard frame (take_context_cycle_) is a SLOT fact: a new
  // take performs against the slot's frame, and one cancelled short of
  // its period must leave the standing take's cycle as it was.
  if (retake_period_.load() <= 0) {
    take_context_cycle_.store(context.island->activeTakeHeardCycle());
  }

  rec_state_.store((int)RecState::Capturing);
  awaiting_start_at.store(0);
  write_position.store(0);
  live_duration_samples.store(0);
  capture_cap_ =
      through_map_capture_ ? take_map_.period() : retake_period_.load();
  capture_base_ = captureBase();
  // THE CAPTURE WINDOW (performance.md §3): content position 0 holds the
  // input that arrived at heard time `target`, (target − compensated)
  // samples after this block's first arrival. A negative delta — the
  // boundary just passed — reaches back into the pre-record ring.
  capture_uses_ring_ = (context.prerecord_ring != nullptr);
  capture_next_clock_ = context.input_clock + (target - compensated_pos);
  underrun_logged_ = false;
  // The MIDI window: a MIDI arrival is only OUTPUT-latency behind the
  // heard clock, so its window opens (audio − MIDI compensation) later
  // on the arrival clock. Events already in the history that fall inside
  // it are picked up.
  midi_capture_next_clock_ =
      capture_next_clock_ - context.input_latency + context.midi_latency;
  midi_history_cursor_ =
      context.midi_history ? context.midi_history->oldestSeq() : 0;
  capture_held_.clear();
  capture_prelude_.clear();
  midi_prelude_folded_ = false;
  midi_lost_logged_ = false;
  midi_full_logged_ = false;
}

ClipNode::TakeState ClipNode::startRecording(int64_t through_map_commit_cycle) {
  if (!mayRecord()) return {};
  TakeState displaced = prepareRecording(through_map_commit_cycle);
  publishArm();
  return displaced;
}

ClipNode::TakeState ClipNode::prepareRecording(
    int64_t through_map_commit_cycle) {
  jassert(mayRecord());
  TakeState displaced = reserveTakeStorage(through_map_commit_cycle);
  duration_samples.store(0);
  live_duration_samples.store(0);
  return displaced;
}

ClipNode::TakeState ClipNode::reserveTakeStorage(
    int64_t through_map_commit_cycle) {
  // Silence first: render reads the content-sounds gate before content.
  is_playing.store(false);
  // An instrument slot on the chain makes this a MIDI take. The kind and
  // the channel count are fixed here: the audio thread reads both only
  // after it sees Armed.
  const bool midi_take = fxChain()->hasInstrumentSlot();
  content_kind_.store((int)(midi_take ? ContentKind::Midi : ContentKind::Audio));
  TakeState displaced;
  if (midi_take) {
    // A sequence of the take's own, reserved whole: capture never
    // allocates, and the one it displaces is never written again.
    displaced.midi =
        swapMidi(std::make_unique<MidiSequence>(MidiSequence::kMaxEvents));
    capture_channels_ = 1;
  } else {
    capture_channels_ = isStereoInput() ? 2 : 1;
    const int want = (int)std::min<int64_t>(
        kMaxTakeSamples, std::numeric_limits<int>::max() - 64);
    // A reservation that already fits (an arm cancelled before it
    // captured left it) is the take's; else a new one displaces the
    // content and the reservation that content referred into.
    if (take_storage_ == nullptr ||
        take_storage_->channels() != capture_channels_ ||
        take_storage_->capacity() < want) {
      storage_rt_.store(nullptr);
      displaced.storage = std::move(take_storage_);
      take_storage_ = TakeStorage::reserve(capture_channels_, want);
      using Buffer = juce::AudioBuffer<float>;
      if (take_storage_ != nullptr) {
        displaced.buffer = swapContent(std::make_unique<Buffer>(
            take_storage_->channelArray(), capture_channels_, want));
        storage_rt_.store(take_storage_.get());
      } else {
        // The OS refused the reservation: a plain heap buffer.
        displaced.buffer =
            swapContent(std::make_unique<Buffer>(capture_channels_, want));
      }
    }
  }
  // The capture facts start over (a new take sets its period after this).
  retake_period_.store(0);
  map_commit_cycle_.store(through_map_commit_cycle);
  through_map_capture_ = false;
  cap_hit_.store(false);
  write_position.store(0);
  awaiting_start_at.store(0);
  stop_requested_.store(false);
  stop_pending_gen_.store(0);
  if (!midi_take) {
    // The reservation is never cleared whole (touching its pages would
    // commit them): the reach is committed first, then the one span a
    // through-map take reads without having written it — its dense
    // [0, C) — is zeroed.
    commitTakeReach(getEffectiveQuantum());
    if (through_map_commit_cycle > 0) clearTakeSpan(through_map_commit_cycle);
  }
  return displaced;
}

void ClipNode::publishArm() {
  if (recState() != RecState::Idle) return;
  rec_state_.store((int)RecState::Armed);
  rootNode()->takeArmed();
}

void ClipNode::stopRecording(uint32_t group_generation) {
  switch (recState()) {
    case RecState::Armed:
      // Never captured: a CANCEL. A new take's cancel hands the slot back
      // at settleRetake.
      rec_state_.store((int)RecState::Idle);
      awaiting_start_at.store(0);
      map_commit_cycle_.store(0);
      if (retake_period_.load() > 0) {
        retake_period_.store(0);
        retake_cancelled_.store(true);
      } else {
        // The clip is empty again, and an empty clip's kind is its
        // chain's to say (isMidiClip).
        content_kind_.store((int)ContentKind::Audio);
      }
      rootNode()->takeCancelled();
      juce::Logger::writeToLog("ClipNode: Arm cancelled before capture");
      break;

    case RecState::Capturing:
      // A REQUEST: the take is the audio thread's to end, at a block top
      // (consumeStopRequest) — on to the boundary it chooses there, or,
      // for an island's first take, at that top.
      if (group_generation != 0) {
        stop_pending_gen_.store(group_generation);
      } else {
        stop_requested_.store(true);
      }
      juce::Logger::writeToLog("ClipNode: Stop requested");
      break;

    case RecState::PendingStop:
    case RecState::Idle:
      break;  // already stopping / nothing to stop
  }
}

void ClipNode::commitRecording(const ProcessContext& context,
                               int64_t final_duration) {
  if (recState() == RecState::Idle) return;
  jassert(context.island != nullptr);
  AudioNode* island = context.island;
  const int64_t L = write_position.load();
  const int64_t Q = context.quantum;
  int64_t duration = L;

  const int64_t map_C = through_map_capture_ ? map_commit_cycle_.load() : 0;
  const int64_t retake_P = retake_period_.load();
  if (retake_P > 0) {
    // A NEW TAKE (takes.md): the slot's duration, origin, map and base
    // all stand. The recorded extent covers what was written behind the
    // shared base and the whole old extent of a collapsed slot, so
    // compaction keeps what an uncollapse would expose.
    duration = duration_samples.load();
    write_position.store(
        std::max<int64_t>(capture_base_ + L, collapsed_from_.load()));
    RtLog::instance().post(
        "ClipNode: New take commit - period=%lld (heard L=%lld)",
        (long long)duration, (long long)L);
  } else if (map_C > 0) {
    // A THROUGH-MAP TAKE is the mapping node's full inner cycle: the
    // dense [0, C) span, silent wherever the mapped clock never wrote.
    // Heard time chose WHEN the commit fired; C is what commits.
    duration = map_C;
    RtLog::instance().post(
        "ClipNode: Through-map commit - C=%lld (heard L=%lld)",
        (long long)map_C, (long long)L);
  } else if (Q > 0 && final_duration <= 0) {
    const auto snap = timing::snapCommittedDuration(L, Q);
    duration = snap.duration;
    // A take stores no map: whole is no window. The one exception is an
    // unsnapped stop — the take is padded to the boundary but what
    // sounds is [0, L): the island's provisional definer window, real
    // geometry (a group take's is lifted onto its stack at settle).
    if (snap.loop_end < snap.duration) setLoopPoints(0, snap.loop_end);
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
  }

  // THE END SEAM (vst3.md §8.4): a note still down when the take ends
  // is closed at its last sample, so the content owns every release it
  // needs. Heard frame on a through-map take (folded like every capture
  // write), content frame otherwise; the capture facts still stand.
  if (contentKind() == ContentKind::Midi && capture_held_.any()) {
    const int64_t last = through_map_capture_ ? L - 1 : duration - 1;
    float unused_peak = 0.0f;
    capture_held_.forEachHeld([&](int ch, int note, juce::uint8) {
      const juce::uint8 off[3] = {(juce::uint8)(0x80 | ch), (juce::uint8)note,
                                  0};
      if (last >= 0) captureMidiEvent(last, off, 3, unused_peak);
    });
    capture_held_.clear();
  }

  duration_samples.store(duration);  // > 0 is what "committed" means

  // The island's first commit establishes Q, stored once at the root
  // with this clip's origin as the zero.
  const int64_t origin = origin_samples.load();
  if (Q == 0) {
    island->establishIsland(duration, origin);
    RtLog::instance().post(
        "ClipNode: Island quantum established: Q=%lld zero=%lld",
        (long long)duration, (long long)origin);
  }
  RtLog::instance().post(
      "ClipNode: Commit. Duration=%lld, Origin=%lld, Launch(derived)=%lld",
      (long long)duration, (long long)origin,
      (long long)timing::launchPointFor(origin, duration));

  is_playing.store(true);
  committed_this_block_.store(true);

  // The capture facts end with the take.
  map_commit_cycle_.store(0);
  through_map_capture_ = false;
  take_map_ = timing::TimeMap::none();
  map_anchor_off_ = 0;
  capture_cap_ = 0;
  capture_base_ = 0;
  // A new take's list append is the message thread's (settleRetake); the
  // clip already sounds the new content.
  if (retake_P > 0) {
    retake_period_.store(0);
    retake_committed_.store(true);
  }
  stop_requested_.store(false);
  awaiting_stop_at.store(0);
  // THE END-OF-TAKE ORDER (RecState): Idle follows every fact of the
  // commit — the message thread settles a clip it sees Idle — and the
  // island's count drops last: an island seen with no live take has
  // every clip of the performance settled.
  rec_state_.store((int)RecState::Idle);
  island->takeCommitted();
}

}  // namespace celestrian
