#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>

namespace celestrian {

/**
 * The live MIDI mailbox (docs/vst3.md §8, phase 4): a lock-free
 * single-producer/single-consumer ring between the OS MIDI thread
 * (push) and the audio callback (drainTo). Fixed POD storage — no
 * locks, no allocation on either side (performance.md §1 applies to
 * the drain side; the push side is a realtime-ish MIDI thread that
 * deserves the same manners).
 *
 * Scope: CHANNEL messages only (≤ 3 bytes — notes, CC, pitch bend).
 * SysEx is ignored at push.
 *
 * Timestamps (phase 5): each event carries JUCE's arrival timestamp
 * (seconds on Time::getMillisecondCounterHiRes's clock — the clock
 * every MidiInput backend stamps with). The timestamped drain spreads
 * the events that arrived since the previous drain across the block
 * in proportion (the MidiMessageCollector rule): sub-block onsets for
 * both play-through and recording. The legacy drain (no timestamps)
 * lands everything at offset 0.
 *
 * Overflow drops the NEWEST event and counts it (droppedCount — a
 * diagnostics readout, not a hidden truncation; the UI can surface
 * it). 1024 pending events is far beyond human playing between two
 * audio callbacks.
 */
class MidiInputQueue {
 public:
  static constexpr int kCapacity = 1024;

  /** MIDI-thread side. Ignores messages longer than 3 bytes (SysEx). */
  void push(const juce::MidiMessage& message) {
    const int size = message.getRawDataSize();
    if (size <= 0 || size > 3) return;
    const auto scope = fifo_.write(1);
    if (scope.blockSize1 + scope.blockSize2 < 1) {
      dropped_.fetch_add(1);
      return;
    }
    Event& event = events_[(size_t)scope.startIndex1];
    memcpy(event.bytes, message.getRawData(), (size_t)size);
    event.size = size;
    event.time = message.getTimeStamp();
  }

  /** Audio-thread side: appends every pending event to `out` at block
   * offset 0. `out` must have been ensureSize'd on the message thread
   * (the engine preallocates) so addEvent never grows it here. */
  void drainTo(juce::MidiBuffer& out) {
    const auto scope = fifo_.read(fifo_.getNumReady());
    for (int i = 0; i < scope.blockSize1; ++i)
      out.addEvent(events_[(size_t)(scope.startIndex1 + i)].bytes,
                   events_[(size_t)(scope.startIndex1 + i)].size, 0);
    for (int i = 0; i < scope.blockSize2; ++i)
      out.addEvent(events_[(size_t)(scope.startIndex2 + i)].bytes,
                   events_[(size_t)(scope.startIndex2 + i)].size, 0);
  }

  /**
   * Audio-thread side, TIMESTAMPED (phase 5): `now_seconds` is the
   * callback's entry time on the same clock as the event stamps. The
   * interval since the previous timestamped drain is mapped onto
   * [0, num_samples): an event stamped a fraction f of the way through
   * that interval lands at offset f·num_samples (clamped). The first
   * drain (no interval yet) and unstamped events land at 0.
   */
  void drainTo(juce::MidiBuffer& out, int num_samples, double now_seconds) {
    const double elapsed = last_drain_time_ > 0.0 ? now_seconds - last_drain_time_
                                                  : 0.0;
    const double start = now_seconds - elapsed;
    last_drain_time_ = now_seconds;
    const auto place = [&](const Event& e) {
      int offset = 0;
      if (elapsed > 0.0 && num_samples > 0 && e.time > 0.0) {
        const double frac = (e.time - start) / elapsed;
        offset = (int)(frac * (double)num_samples);
        offset = std::clamp(offset, 0, num_samples - 1);
      }
      out.addEvent(e.bytes, e.size, offset);
    };
    const auto scope = fifo_.read(fifo_.getNumReady());
    for (int i = 0; i < scope.blockSize1; ++i)
      place(events_[(size_t)(scope.startIndex1 + i)]);
    for (int i = 0; i < scope.blockSize2; ++i)
      place(events_[(size_t)(scope.startIndex2 + i)]);
  }

  /** Events dropped on overflow since construction (diagnostics). */
  int droppedCount() const { return dropped_.load(); }

 private:
  struct Event {
    juce::uint8 bytes[3];
    int size;
    double time;  // JUCE arrival stamp, seconds (0 = unstamped)
  };

  juce::AbstractFifo fifo_{kCapacity};
  std::array<Event, kCapacity> events_{};
  std::atomic<int> dropped_{0};
  double last_drain_time_ = 0.0;  // audio-thread only
};

/**
 * The MIDI ARRIVAL HISTORY (docs/vst3.md §8, phase 5) — the note twin
 * of the pre-record ring (docs/performance.md §3): every drained event
 * is appended with its ARRIVAL INDEX on the engine's monotonic input
 * clock (input_clock + block offset). Recording clips read their
 * capture window from here rather than from the live block, so a take
 * whose latency-compensated start lies slightly in the past (the
 * pickup, the first-clip arm) still gets the events that already
 * arrived — exactly how audio takes reach back into the ring.
 *
 * Fixed POD ring, audio-thread only (written by the drain, read by
 * clips in the same callback). Entries are addressed by a monotone
 * SEQUENCE number: `total()` is the count ever pushed; entry(seq) is
 * valid for seq in [total − kCapacity, total). A reader whose cursor
 * fell further behind lost events (the drop-and-count discipline).
 */
class MidiHistory {
 public:
  static constexpr int kCapacity = 4096;

  struct Entry {
    int64_t arrival = 0;  // input-clock index the event arrived at
    juce::uint8 bytes[3] = {0, 0, 0};
    juce::uint8 size = 0;
  };

  void push(int64_t arrival, const juce::uint8* bytes, int size) {
    if (size <= 0 || size > 3) return;
    Entry& e = ring_[(size_t)(total_ % kCapacity)];
    e.arrival = arrival;
    e.size = (juce::uint8)size;
    memcpy(e.bytes, bytes, (size_t)size);
    for (int k = size; k < 3; ++k) e.bytes[k] = 0;
    ++total_;
  }

  /** Append every event of `block` (offsets relative to `input_clock`). */
  void pushBlock(const juce::MidiBuffer& block, int64_t input_clock) {
    for (const auto metadata : block) {
      push(input_clock + metadata.samplePosition, metadata.data,
           metadata.numBytes);
    }
  }

  int64_t total() const { return total_; }
  int64_t oldestSeq() const { return std::max<int64_t>(0, total_ - kCapacity); }
  const Entry& entry(int64_t seq) const {
    return ring_[(size_t)(seq % kCapacity)];
  }

 private:
  std::array<Entry, kCapacity> ring_{};
  int64_t total_ = 0;
};

}  // namespace celestrian
