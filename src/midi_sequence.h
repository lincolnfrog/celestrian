#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <vector>

namespace celestrian {

/**
 * One recorded MIDI event in a take's CONTENT frame (docs/vst3.md §8,
 * phase 5): `pos` is the content position in samples — the same frame
 * audio content lives in (content[0] belongs to the clip's origin) —
 * plus the raw channel message (≤ 3 bytes; SysEx never enters, see
 * MidiInputQueue). POD by design: the sequence is a plain array the
 * audio thread appends to and reads from.
 */
struct MidiEvent {
  int64_t pos = 0;
  juce::uint8 bytes[3] = {0, 0, 0};
  juce::uint8 size = 0;

  bool isNoteOn() const {
    return size == 3 && (bytes[0] & 0xF0) == 0x90 && bytes[2] > 0;
  }
  bool isNoteOff() const {
    return size == 3 && ((bytes[0] & 0xF0) == 0x80 ||
                         ((bytes[0] & 0xF0) == 0x90 && bytes[2] == 0));
  }
  int channel0() const { return bytes[0] & 0x0F; }  // 0-based
  int note() const { return bytes[1]; }
  int velocity() const { return bytes[2]; }
};

/**
 * A take's note sequence: the MIDI twin of the clip's audio buffer
 * (Q-V4: samples in the engine content buffer, QTime only in the save
 * format).
 *
 * Storage discipline mirrors the audio take buffer: the clip reaches
 * its sequence through
 * ONE atomic pointer; the MESSAGE thread allocates a fixed-capacity
 * sequence at ARM (kMaxEvents — ~1 MiB, "hours of playing"; the wall
 * drops-and-counts instead of growing) and swaps replacements only on
 * idle clips, retiring the old one through the engine reclaimer. The
 * AUDIO thread appends during capture (sorted by content position —
 * insertion is a bounded backwards shift, and arrivals are monotone by
 * construction so the shift is almost always zero) and reads during
 * render (the same thread; count_ orders the two within a callback).
 * The message thread reads only when the clip is Idle (getWaveform's
 * Idle gate) — commit's seq-cst Idle store publishes every capture write.
 */
class MidiSequence {
 public:
  static constexpr int kMaxEvents = 1 << 16;

  explicit MidiSequence(int capacity = 0) { reserve(capacity); }

  /** Message thread, idle clip only: (re)allocate storage for
   * `capacity` events and empty the sequence. */
  void reserve(int capacity) {
    events_.assign((size_t)std::max(0, capacity), MidiEvent{});
    count_.store(0);
    dropped_.store(0);
  }

  int capacity() const { return (int)events_.size(); }
  int count() const { return count_.load(); }
  int dropped() const { return dropped_.load(); }
  bool empty() const { return count() == 0; }
  const MidiEvent* data() const { return events_.data(); }
  const MidiEvent& operator[](int i) const { return events_[(size_t)i]; }

  /** Audio thread (capture): append at its sorted place. Full → the
   * event is dropped and counted (the wall guard: integrity, not
   * policy — a 65k-event take is beyond human playing). */
  void append(int64_t pos, const juce::uint8* bytes, int size) {
    const int n = count_.load();
    if (n >= capacity() || size <= 0 || size > 3) {
      dropped_.fetch_add(1);
      return;
    }
    // Bounded backwards shift keeps the array sorted by pos (stable:
    // equal positions keep arrival order).
    int i = n;
    while (i > 0 && events_[(size_t)(i - 1)].pos > pos) {
      events_[(size_t)i] = events_[(size_t)(i - 1)];
      --i;
    }
    MidiEvent& e = events_[(size_t)i];
    e.pos = pos;
    e.size = (juce::uint8)size;
    memcpy(e.bytes, bytes, (size_t)size);
    for (int k = size; k < 3; ++k) e.bytes[k] = 0;
    count_.store(n + 1);
  }

  /** Message thread (load / splice): replace the whole content with
   * `events` (sorted on the way in), capacity = exactly their count. */
  void assign(std::vector<MidiEvent> events) {
    std::stable_sort(events.begin(), events.end(),
                     [](const MidiEvent& a, const MidiEvent& b) {
                       return a.pos < b.pos;
                     });
    events_ = std::move(events);
    count_.store((int)events_.size());
    dropped_.store(0);
  }

  /** A copy of the committed events [0, count) (message thread, idle
   * clip). */
  std::vector<MidiEvent> snapshot() const {
    const int n = count();
    return std::vector<MidiEvent>(events_.begin(), events_.begin() + n);
  }

  /** Index of the first event with pos >= `p` (audio thread; binary
   * search over the sorted prefix). */
  int lowerBound(int64_t p) const {
    const int n = count();
    int lo = 0, hi = n;
    while (lo < hi) {
      const int mid = lo + (hi - lo) / 2;
      if (events_[(size_t)mid].pos < p)
        lo = mid + 1;
      else
        hi = mid;
    }
    return lo;
  }

 private:
  std::vector<MidiEvent> events_;
  std::atomic<int> count_{0};
  std::atomic<int> dropped_{0};
};

/**
 * Held-note bookkeeping (128 notes × 16 channels as bitmasks): capture
 * uses it for the take meter, render uses it to release notes cut by a
 * content discontinuity (loop seam, window seam, one-shot rest,
 * transport stop) — the "hanging notes closed at the seam" rule
 * (docs/vst3.md §8). Plain POD; the owner decides which thread.
 */
struct HeldNotes {
  std::array<juce::uint16, 128> channels{};  // bit c = channel c held

  void clear() { channels.fill(0); }
  bool any() const {
    for (const auto c : channels)
      if (c) return true;
    return false;
  }
  /** Track a raw channel message; returns true if it was a note event. */
  bool track(const juce::uint8* bytes, int size) {
    if (size != 3) return false;
    const int status = bytes[0] & 0xF0;
    const int ch = bytes[0] & 0x0F;
    const int note = bytes[1] & 0x7F;
    if (status == 0x90 && bytes[2] > 0) {
      channels[(size_t)note] |= (juce::uint16)(1u << ch);
      return true;
    }
    if (status == 0x80 || (status == 0x90 && bytes[2] == 0)) {
      channels[(size_t)note] &= (juce::uint16)~(1u << ch);
      return true;
    }
    return false;
  }
  /** Add a note-off for every held note at `offset` and clear. The
   * buffer must be preallocated (audio thread). */
  void releaseInto(juce::MidiBuffer& out, int offset) {
    for (int note = 0; note < 128; ++note) {
      const juce::uint16 mask = channels[(size_t)note];
      if (mask == 0) continue;
      for (int ch = 0; ch < 16; ++ch) {
        if (mask & (1u << ch)) {
          out.addEvent(juce::MidiMessage::noteOff(ch + 1, note), offset);
        }
      }
      channels[(size_t)note] = 0;
    }
  }
};

}  // namespace celestrian
