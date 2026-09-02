#pragma once

#include <juce_core/juce_core.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

namespace celestrian {

/**
 * TakeStorage — the live take's memory: ADDRESS SPACE reserved up
 * front, pages COMMITTED ahead of the write head.
 *
 * A plain malloc of `kMaxTakeSamples` per channel would rely on lazy
 * overcommit: free on macOS/Linux, but Windows charges the whole
 * reservation to the commit limit the moment it is allocated (five
 * drum mics = a 20 GB commit charge before a note is played), and the
 * allocation is slow enough to split a group arm across audio blocks.
 * So the reservation stays (record indefinitely, up to that bound) but
 * memory is committed in chunks as the take grows:
 *
 *   - reserve(): address space only (VirtualAlloc MEM_RESERVE / mmap
 *     MAP_NORESERVE) — nothing is charged.
 *   - commitTo(samples): MESSAGE THREAD, called by the engine's grower
 *     every poll — keeps `headroom` seconds committed past the write
 *     head (Windows: VirtualAlloc MEM_COMMIT; POSIX: pages are already
 *     lazily backed, so this only advances the bookkeeping).
 *   - committed(): the AUDIO THREAD's write wall. Capture never writes
 *     past it; reaching it (the grower starved for a whole headroom —
 *     a stalled message thread) finishes the take cleanly at the last
 *     boundary that fits.
 *
 * The juce::AudioBuffer the clip renders from REFERS to these channels
 * (the referring constructor); ownership of the storage travels with
 * that buffer wherever it goes (ClipNode, TakeState, Edit payload) and
 * is retired through the engine reclaimer like the buffer itself.
 */
class TakeStorage {
 public:
  /** Reserve `capacity` samples × `channels` of address space. Null when
   * the OS refuses (the caller falls back to a plain heap buffer). */
  static std::unique_ptr<TakeStorage> reserve(int channels, int64_t capacity);
  ~TakeStorage();

  TakeStorage(const TakeStorage&) = delete;
  TakeStorage& operator=(const TakeStorage&) = delete;

  int channels() const { return channels_; }
  int64_t capacity() const { return capacity_; }
  /** Channel pointer array for juce::AudioBuffer's referring ctor. */
  float* const* channelArray() const { return channel_ptrs_.data(); }
  /** Samples per channel the audio thread may write (the wall). */
  int64_t committed() const { return committed_.load(std::memory_order_acquire); }
  /** MESSAGE THREAD: ensure at least `samples` per channel are committed
   * (rounded up to whole chunks, clamped to the capacity). Returns the
   * committed count after the call; unchanged on failure. */
  int64_t commitTo(int64_t samples);

  /** Commit granularity (samples): 2^20 (4 MB per channel). */
  static constexpr int64_t kChunkSamples = int64_t{1} << 20;

 private:
  TakeStorage() = default;
  void* base_ = nullptr;
  size_t bytes_per_channel_ = 0;  // page-rounded channel stride
  size_t total_bytes_ = 0;
  int channels_ = 0;
  int64_t capacity_ = 0;
  std::atomic<int64_t> committed_{0};
  std::vector<float*> channel_ptrs_;
  bool lazy_backed_ = false;  // POSIX: the OS commits on touch
};

}  // namespace celestrian
