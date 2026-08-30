#include "take_storage.h"

#include <algorithm>

#if JUCE_WINDOWS
#define NOMINMAX
#include <windows.h>
#else
#include <sys/mman.h>
#include <unistd.h>
#endif

namespace celestrian {

namespace {
size_t pageSize() {
#if JUCE_WINDOWS
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  return (size_t)std::max<DWORD>(si.dwAllocationGranularity, si.dwPageSize);
#else
  const long p = sysconf(_SC_PAGESIZE);
  return p > 0 ? (size_t)p : 4096;
#endif
}
size_t roundUp(size_t n, size_t to) { return ((n + to - 1) / to) * to; }
}  // namespace

std::unique_ptr<TakeStorage> TakeStorage::reserve(int channels, int64_t capacity) {
  if (channels <= 0 || capacity <= 0) return nullptr;
  std::unique_ptr<TakeStorage> s(new TakeStorage());
  const size_t page = pageSize();
  s->channels_ = channels;
  s->capacity_ = capacity;
  s->bytes_per_channel_ = roundUp((size_t)capacity * sizeof(float), page);
  s->total_bytes_ = s->bytes_per_channel_ * (size_t)channels;
#if JUCE_WINDOWS
  s->base_ = VirtualAlloc(nullptr, s->total_bytes_, MEM_RESERVE, PAGE_READWRITE);
  if (s->base_ == nullptr) return nullptr;
  s->lazy_backed_ = false;
#else
  int flags = MAP_PRIVATE | MAP_ANONYMOUS;
#ifdef MAP_NORESERVE
  flags |= MAP_NORESERVE;
#endif
  void* p = mmap(nullptr, s->total_bytes_, PROT_READ | PROT_WRITE, flags, -1, 0);
  if (p == MAP_FAILED) return nullptr;
  s->base_ = p;
  s->lazy_backed_ = true;  // pages materialize on first touch
#endif
  s->channel_ptrs_.resize((size_t)channels);
  for (int c = 0; c < channels; ++c) {
    s->channel_ptrs_[(size_t)c] = reinterpret_cast<float*>(
        static_cast<char*>(s->base_) + (size_t)c * s->bytes_per_channel_);
  }
  // Lazily-backed reservations are writable end to end from the start;
  // the wall is the capacity. Eager platforms start at zero and grow.
  s->committed_.store(s->lazy_backed_ ? capacity : 0, std::memory_order_release);
  return s;
}

TakeStorage::~TakeStorage() {
  if (base_ == nullptr) return;
#if JUCE_WINDOWS
  VirtualFree(base_, 0, MEM_RELEASE);
#else
  munmap(base_, total_bytes_);
#endif
  base_ = nullptr;
}

int64_t TakeStorage::commitTo(int64_t samples) {
  const int64_t have = committed_.load(std::memory_order_acquire);
  if (lazy_backed_ || samples <= have) return have;
  int64_t want = std::min(capacity_, roundUp((size_t)samples, (size_t)kChunkSamples) > (size_t)capacity_
                                        ? capacity_
                                        : (int64_t)roundUp((size_t)samples, (size_t)kChunkSamples));
  if (want <= have) return have;
#if JUCE_WINDOWS
  const size_t from = (size_t)have * sizeof(float);
  const size_t to = (size_t)want * sizeof(float);
  for (int c = 0; c < channels_; ++c) {
    char* ch = static_cast<char*>(base_) + (size_t)c * bytes_per_channel_;
    if (VirtualAlloc(ch + from, to - from, MEM_COMMIT, PAGE_READWRITE) == nullptr) {
      return have;  // commit refused (commit limit): the wall stays
    }
  }
#endif
  committed_.store(want, std::memory_order_release);
  return want;
}

}  // namespace celestrian
