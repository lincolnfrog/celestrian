#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <vector>

namespace celestrian {

inline constexpr int kMidiChannels = 16;
inline constexpr int kMidiNotes = 128;
/** The storage one channel message takes in a juce::MidiBuffer — its
 * sample position (int32), its size (uint16), up to three bytes: what a
 * preallocation of one is counted in. */
inline constexpr int kMidiBufferEventBytes =
    (int)(sizeof(juce::int32) + sizeof(juce::uint16)) + 3;

/**
 * One recorded MIDI event (vst3.md §8): a raw channel message (≤ 3
 * bytes; SysEx never enters — MidiInputQueue) at `pos`, a STORAGE
 * position in samples: where an audio sample of the same moment sits in
 * the clip's buffer, the content base included (ClipNode::
 * getContentBase). Content position p of a collapsed slot is stored at
 * base + p. POD: the sequence is a plain array the audio thread appends
 * to and reads from.
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
 * A take's note sequence: the MIDI twin of the clip's audio buffer —
 * samples in the engine, QTime only in the save format — under the same
 * pointer law (ClipNode's class comment). The MESSAGE thread allocates a
 * fixed capacity at arm (kMaxEvents, ~1 MiB; a full sequence refuses
 * further events rather than grow) and replaces the sequence only on an
 * idle clip. The AUDIO thread appends during capture, sorted by
 * position, and reads during render; count_ orders the two within a
 * callback. The message thread reads only while the clip is Idle: the
 * commit's Idle store publishes every capture write.
 */
class MidiSequence {
 public:
  static constexpr int kMaxEvents = 1 << 16;

  /** An empty sequence with storage for `capacity` events. Once a clip
   * holds a sequence its storage is never reallocated: a take that needs
   * room gets a NEW sequence (ClipNode's arm) and the one it displaces
   * is retired whole, so nothing a render may hold moves under it. */
  explicit MidiSequence(int capacity = 0)
      : events_((size_t)std::max(0, capacity)) {}

  int capacity() const { return (int)events_.size(); }
  int count() const { return count_.load(); }
  const MidiEvent& operator[](int i) const { return events_[(size_t)i]; }

  /** Audio thread (capture): insert at its sorted place. False when the
   * sequence is full or the message is not a channel message: the event
   * is not stored. */
  bool append(int64_t pos, const juce::uint8* bytes, int size) {
    const int n = count_.load();
    if (n >= capacity() || size <= 0 || size > 3) return false;
    // A bounded backwards shift keeps the array sorted by pos; equal
    // positions keep arrival order. Arrivals are all but monotone, so
    // the shift is almost always zero.
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
    return true;
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
};

/**
 * Held-note bookkeeping: 128 notes × 16 channels as bitmasks, plus the
 * velocity each held note was struck with. Capture uses it for the take
 * meter and the boundary notes (vst3.md §8.4: a note held across the
 * take's start lands as a note-on at content 0, one held across its end
 * is closed at the last sample); render uses it to release the notes a
 * content discontinuity cuts (vst3.md §8.3: hanging notes close at the
 * seam). Plain POD; the owner decides which thread.
 */
struct HeldNotes {
  /** The most notes that can be held at once. */
  static constexpr int kMaxHeld = kMidiChannels * kMidiNotes;

  std::array<juce::uint16, kMidiNotes> channels{};  // bit c = channel c held
  // velocity[ch * kMidiNotes + note]: the note-on velocity while held.
  std::array<juce::uint8, kMaxHeld> velocity{};

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
      velocity[(size_t)(ch * kMidiNotes + note)] = bytes[2];
      return true;
    }
    if (status == 0x80 || (status == 0x90 && bytes[2] == 0)) {
      channels[(size_t)note] &= (juce::uint16)~(1u << ch);
      return true;
    }
    return false;
  }
  /** Calls fn(channel0, note, velocity) for every held note. */
  template <typename Fn>
  void forEachHeld(Fn&& fn) const {
    for (int note = 0; note < kMidiNotes; ++note) {
      const juce::uint16 mask = channels[(size_t)note];
      if (mask == 0) continue;
      for (int ch = 0; ch < kMidiChannels; ++ch) {
        if (mask & (1u << ch)) {
          fn(ch, note, velocity[(size_t)(ch * kMidiNotes + note)]);
        }
      }
    }
  }
  /** Add a note-off for every held note at `offset` and clear. The
   * buffer must be preallocated (audio thread). */
  void releaseInto(juce::MidiBuffer& out, int offset) {
    forEachHeld([&](int ch, int note, juce::uint8) {
      out.addEvent(juce::MidiMessage::noteOff(ch + 1, note), offset);
    });
    clear();
  }
};

/**
 * THE SOUND-OFF PAIR (vst3.md §8.3): All Notes Off (CC 123) then All
 * Sound Off (CC 120) on every channel in `channel_mask`, at `offset`.
 * Sent to an instrument ONCE per closing edge — a transport stop, the
 * gate landing shut (mute, solo-silence, a sequence cut), a new take's
 * silence, content handed down stopped (a bounce tail:
 * ProcessContext::content_silent with no rest), a device stop — so
 * notes the instrument holds release through its own envelope while the
 * chain after it rings. A rest is not one: it releases the content's
 * own notes and leaves the instrument be. Fixed-size events; the buffer
 * is preallocated.
 */
inline void addSoundOff(juce::MidiBuffer& out, juce::uint16 channel_mask,
                        int offset) {
  for (int ch = 0; ch < kMidiChannels; ++ch) {
    if (!(channel_mask & (1u << ch))) continue;
    out.addEvent(juce::MidiMessage::allNotesOff(ch + 1), offset);
    out.addEvent(juce::MidiMessage::allSoundOff(ch + 1), offset);
  }
}

}  // namespace celestrian
