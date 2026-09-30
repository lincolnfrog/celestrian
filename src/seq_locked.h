#pragma once

#include <atomic>
#include <cstdint>

namespace celestrian {

/**
 * THE seqlock (docs/performance.md §1): one writer at a time, any number
 * of audio-thread readers, over a small all-atomic record that must be
 * read as ONE fact. The three consumers — a node's TimeMap
 * (AudioNode::storedMap/setMap), a stack's island triple
 * (StackNode::readIslandFacts/setIslandFacts) and a clip's take table
 * (ClipNode::readCompView/publishTakeTable) — share this protocol so the
 * memory orders are stated once and are right once. JUCE-free.
 *
 * THE LATCH (two copies): every record is stored twice, a PRIMARY
 * (slot 0) and a SHADOW (slot 1). A write bumps the mark to odd and
 * rewrites the primary, then bumps it to even and rewrites the shadow;
 * a reader reads the primary on an even mark and the shadow on an odd
 * one — always the copy no write is touching. A writer descheduled
 * mid-write (the OS preempts the message thread whenever it likes)
 * therefore never stalls or tears a reader: the copy it reads is whole,
 * one write old at most. (The single-copy form tore exactly there: a
 * preempted writer held the mark odd while a reader spun through its
 * retry bound in under a microsecond and took a mixed record.)
 * Single-field readers read the primary directly — each field is its
 * own atomic; only multi-field reads need the protocol.
 *
 * Memory orders (Boehm, "Can seqlocks get along with programming
 * language memory models?"), applied to each copy:
 *  - WRITER: each bump is a RELEASE RMW (the other copy's stores, made
 *    before it, are visible to a reader that sees the new mark), then a
 *    RELEASE fence (this copy's stores, made after it, cannot be seen
 *    by a reader that still sees the old mark), then the payload stores
 *    (relaxed is enough).
 *  - READER: load the mark ACQUIRE, load the payload of the copy it
 *    names (relaxed), then an ACQUIRE fence, then re-load the mark
 *    (relaxed); an unchanged mark means no write touched that copy.
 * A writer that bumps with a release RMW and then stores relaxed with
 * no fence orders only its PRIOR operations; a reader whose second mark
 * load is acquire orders only its SUBSEQUENT ones. Either admits a torn
 * read on a weakly ordered machine (ARM64); x86 TSO hides both.
 *
 * Bounded retry: a retry needs the writer to make progress during one
 * read, so the loop never spins for real. After kMaxAttempts the reader
 * TAKES WHAT IT HAS — the one after-bound policy, unreachable with a
 * message-thread writer — and callers clamp any count they index with.
 * Never blocks, never allocates.
 */
class SeqLock {
 public:
  static constexpr int kMaxAttempts = 16;

  /** Run `store_payload(slot)` as one write: it stores the whole record
   * into copy `slot` (0 = primary, 1 = shadow) and is called for both,
   * primary first. Single writer at a time. */
  template <typename F>
  void write(F&& store_payload) {
    seq_.fetch_add(1u, std::memory_order_release);  // odd: readers → shadow
    std::atomic_thread_fence(std::memory_order_release);
    store_payload(0);
    seq_.fetch_add(1u, std::memory_order_release);  // even: readers → primary
    std::atomic_thread_fence(std::memory_order_release);
    store_payload(1);
  }

  /** Run `load_payload(slot)` — load the record from copy `slot` —
   * until it observed a stable record, at most kMaxAttempts times.
   * Returns whether the last pass was consistent (false = the bound was
   * hit and the caller holds a best effort). */
  template <typename F>
  bool read(F&& load_payload) const {
    for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
      const uint32_t s1 = seq_.load(std::memory_order_acquire);
      load_payload((int)(s1 & 1u));
      std::atomic_thread_fence(std::memory_order_acquire);
      const uint32_t s2 = seq_.load(std::memory_order_relaxed);
      if (s1 == s2) return true;
    }
    return false;
  }

 private:
  std::atomic<uint32_t> seq_{0};
};

}  // namespace celestrian
