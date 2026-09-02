#pragma once

#include <juce_core/juce_core.h>

#include <array>
#include <cstdarg>
#include <cstdio>
#include <cstring>

namespace celestrian {

/**
 * Fixed-size, allocation-free log ring for code that runs on the audio
 * thread. juce::Logger does file I/O and must never be called from the
 * device callback; post() instead formats into a preallocated slot and
 * drain() (message thread — the engine calls it from getGraphState, i.e.
 * every UI poll) forwards the queued lines to juce::Logger.
 *
 * post() is safe from any thread: producers are serialized by a SpinLock
 * held only for the slot claim + memcpy (bounded, no syscalls). If the
 * lock is contended or the ring is full the message is dropped — these
 * are debug logs; dropping beats blocking the audio thread.
 */
class RtLog {
 public:
  static constexpr int kSlots = 256;
  static constexpr int kMsgLen = 160;

  static RtLog& instance() {
    static RtLog log;
    return log;
  }

  void post(const char* fmt, ...) {
    char msg[kMsgLen];
    va_list args;
    va_start(args, fmt);
    vsnprintf(msg, sizeof(msg), fmt, args);
    va_end(args);

    const juce::SpinLock::ScopedTryLockType lock(producer_lock_);
    if (!lock.isLocked()) return;

    int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
    fifo_.prepareToWrite(1, start1, size1, start2, size2);
    if (size1 > 0) {
      std::memcpy(slots_[(size_t)start1].data(), msg, kMsgLen);
      fifo_.finishedWrite(1);
    }
  }

  // Bounded: juce::Logger::writeToLog does file I/O per line, and a
  // producer posting every block can keep the FIFO permanently full —
  // an unbounded loop then never returns and wedges the message thread
  // (e.g. several armed clips × per-block underrun spam). One
  // slot-count sweep per call keeps every UI poll O(kSlots).
  void drain() {
    for (int drained = 0; drained < kSlots; ++drained) {
      int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
      fifo_.prepareToRead(1, start1, size1, start2, size2);
      if (size1 <= 0) return;
      juce::Logger::writeToLog(juce::String(slots_[(size_t)start1].data()));
      fifo_.finishedRead(1);
    }
  }

 private:
  RtLog() = default;

  juce::AbstractFifo fifo_{kSlots};
  std::array<std::array<char, kMsgLen>, kSlots> slots_;
  juce::SpinLock producer_lock_;
};

}  // namespace celestrian
