#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <array>
#include <atomic>

namespace celestrian {

/**
 * The live MIDI mailbox (docs/vst3.md §8, phase 4): a lock-free
 * single-producer/single-consumer ring between the OS MIDI thread
 * (push) and the audio callback (drainTo). Fixed POD storage — no
 * locks, no allocation on either side (performance.md §1 applies to
 * the drain side; the push side is a realtime-ish MIDI thread that
 * deserves the same manners).
 *
 * Scope (phase 4): CHANNEL messages only (≤ 3 bytes — notes, CC,
 * pitch bend). SysEx is ignored at push. Events drain at block offset
 * 0 — sub-block onset jitter is at most one device block, inaudible
 * for live monitoring; phase 5's recording path will carry finer
 * timestamps alongside.
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
  }

  /** Audio-thread side: appends every pending event to `out` at block
   * offset 0. `out` must have been ensureSize'd on the message thread
   * (the engine preallocates) so addEvent never grows it here. */
  void drainTo(juce::MidiBuffer& out) {
    const auto scope = fifo_.read(fifo_.getNumReady());
    for (int i = 0; i < scope.blockSize1; ++i)
      addEvent(out, events_[(size_t)(scope.startIndex1 + i)]);
    for (int i = 0; i < scope.blockSize2; ++i)
      addEvent(out, events_[(size_t)(scope.startIndex2 + i)]);
  }

  /** Events dropped on overflow since construction (diagnostics). */
  int droppedCount() const { return dropped_.load(); }

 private:
  struct Event {
    juce::uint8 bytes[3];
    int size;
  };

  static void addEvent(juce::MidiBuffer& out, const Event& event) {
    out.addEvent(event.bytes, event.size, 0);
  }

  juce::AbstractFifo fifo_{kCapacity};
  std::array<Event, kCapacity> events_{};
  std::atomic<int> dropped_{0};
};

}  // namespace celestrian
