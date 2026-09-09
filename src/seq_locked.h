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
 * Protocol (Boehm, "Can seqlocks get along with programming language
 * memory models?"):
 *  - WRITER: bump the mark to odd (relaxed), then a RELEASE fence, then
 *    the payload stores (relaxed is enough), then bump to even with a
 *    RELEASE store. The fence keeps every payload store from being
 *    reordered ahead of the odd mark; the release bump keeps every
 *    payload store visible before the even mark.
 *  - READER: load the mark ACQUIRE, load the payload (relaxed), then an
 *    ACQUIRE fence, then re-load the mark (relaxed). The fence keeps the
 *    payload loads from drifting past the second mark load.
 * A writer that bumps with a release RMW and then stores relaxed orders
 * only its PRIOR operations; a reader whose second mark load is acquire
 * orders only its SUBSEQUENT ones. Either admits a torn read on a
 * weakly ordered machine (ARM64); x86 TSO hides both. Hence this class.
 *
 * Bounded retry: a writer's critical section is a handful of stores, so
 * the retry never spins for real. After kMaxAttempts the reader TAKES
 * WHAT IT HAS — the one after-bound policy — and callers clamp any
 * count they index with. Never blocks, never allocates.
 */
class SeqLock {
 public:
  static constexpr int kMaxAttempts = 16;

  /** Run `store_payload` as one write. Single writer at a time. */
  template <typename F>
  void write(F&& store_payload) {
    seq_.fetch_add(1u, std::memory_order_relaxed);  // odd = writing
    std::atomic_thread_fence(std::memory_order_release);
    store_payload();
    seq_.fetch_add(1u, std::memory_order_release);  // even = stable
  }

  /** Run `load_payload` until it observed a stable record, at most
   * kMaxAttempts times. Returns whether the last pass was consistent
   * (false = the bound was hit and the caller holds a best effort). */
  template <typename F>
  bool read(F&& load_payload) const {
    for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
      const uint32_t s1 = seq_.load(std::memory_order_acquire);
      load_payload();
      std::atomic_thread_fence(std::memory_order_acquire);
      const uint32_t s2 = seq_.load(std::memory_order_relaxed);
      if ((s1 & 1u) == 0u && s1 == s2) return true;
    }
    return false;
  }

 private:
  std::atomic<uint32_t> seq_{0};
};

}  // namespace celestrian
