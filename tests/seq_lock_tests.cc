/**
 * SeqLock tests (src/seq_locked.h) — the one seqlock protocol behind the
 * map, the island triple and the take table.
 *
 * The hammer: one writer alternates between two distinct records while
 * a reader spins, and every read must equal one of the two records
 * EXACTLY — never a mix. On x86 the old release-RMW / acquire-load
 * shape passed this by TSO alone; on ARM64 (this machine) a torn read
 * is a real outcome of the old memory orders, so this is the pin. Run
 * it under TSan when the sanitizer build lands (audit D10-4).
 */

#include <juce_core/juce_core.h>

#include <atomic>
#include <thread>

#include "../src/seq_locked.h"
#include "../src/stack_node.h"

namespace celestrian {

namespace {
/** ~microseconds of writer idle between paced writes: a busy spin the
 * optimizer cannot drop (volatile), no syscall (macOS's yield returns
 * at once on an otherwise idle core). */
void pace() {
  for (volatile int k = 0; k < 4000; ++k) {
  }
}
}  // namespace

class SeqLockTests : public juce::UnitTest {
 public:
  SeqLockTests() : juce::UnitTest("SeqLock (one seqlock protocol)") {}

  void runTest() override {
    beginTest("protocol: a stable read reports consistent; the bound "
              "takes what it has");
    {
      SeqLock lock;
      int payload[2] = {0, 0};
      lock.write([&](int slot) { payload[slot] = 7; });
      expectEquals(payload[0], 7, "the write stores the primary…");
      expectEquals(payload[1], 7, "…and the shadow");
      int seen = 0;
      expect(lock.read([&](int slot) { seen = payload[slot]; }), "stable read");
      expectEquals(seen, 7, "payload observed");
    }

    beginTest("latch: a writer stalled mid-write never stalls or tears a reader");
    {
      // THE BUG THE LATCH FIXES: the OS preempts the writer (the
      // message thread) between its payload stores. Single-copy, the
      // mark stayed odd and every read burned its retry bound and took
      // a mixed record. Here the writer parks inside each copy's stores
      // with the record half written; a read in between must come back
      // at once, consistent, and whole — the previous record while the
      // primary is half written, the new one while the shadow is.
      SeqLock lock;
      std::atomic<int64_t> a[2] = {{1}, {1}}, b[2] = {{-1}, {-1}};
      std::atomic<int> parked{-1};  // the copy the writer is parked in
      std::atomic<bool> go{false};
      std::thread writer([&] {
        lock.write([&](int slot) {
          a[slot].store(2, std::memory_order_relaxed);  // half the record
          parked.store(slot);
          while (!go.load()) std::this_thread::yield();
          go.store(false);
          b[slot].store(-2, std::memory_order_relaxed);
        });
        parked.store(2);
      });
      auto readOnce = [&](int64_t& ra, int64_t& rb) {
        return lock.read([&](int slot) {
          ra = a[slot].load(std::memory_order_relaxed);
          rb = b[slot].load(std::memory_order_relaxed);
        });
      };
      int64_t ra = 0, rb = 0;
      while (parked.load() != 0) std::this_thread::yield();
      expect(readOnce(ra, rb), "primary half written: the read is consistent");
      expect(ra == 1 && rb == -1, "…and is the previous record, whole");
      go.store(true);
      while (parked.load() != 1) std::this_thread::yield();
      expect(readOnce(ra, rb), "shadow half written: the read is consistent");
      expect(ra == 2 && rb == -2, "…and is the new record, whole");
      go.store(true);
      writer.join();
      expect(readOnce(ra, rb) && ra == 2 && rb == -2, "after the write: the new record");
    }

    beginTest("hammer: a CONSISTENT read is never torn (tight writer)");
    {
      // Two payload words, two distinct records, a writer that never
      // pauses: a read that reports consistent (unchanged mark across
      // the payload loads) must be one of the two records. Reads that
      // hit the retry bound under this storm are best effort by
      // contract (the real writer is the message thread, which writes
      // rarely) and are not judged here — the paced hammers below are.
      SeqLock lock;
      std::atomic<int64_t> a[2] = {{0}, {0}}, b[2] = {{0}, {0}};
      std::atomic<bool> done{false};
      std::atomic<int> torn{0};
      std::atomic<int> consistent{0};
      std::atomic<int> bounded{0};
      std::thread reader([&] {
        while (!done.load(std::memory_order_relaxed)) {
          int64_t ra = 0, rb = 0;
          const bool ok_read = lock.read([&](int slot) {
            ra = a[slot].load(std::memory_order_relaxed);
            rb = b[slot].load(std::memory_order_relaxed);
          });
          if (!ok_read) {
            bounded.fetch_add(1, std::memory_order_relaxed);
            continue;
          }
          consistent.fetch_add(1, std::memory_order_relaxed);
          const bool ok = (ra == 0 && rb == 0) || (ra == 1 && rb == -1);
          if (!ok) torn.fetch_add(1, std::memory_order_relaxed);
        }
      });
      for (int i = 0; i < 200000; ++i) {
        const bool one = (i & 1) != 0;
        lock.write([&](int slot) {
          a[slot].store(one ? 1 : 0, std::memory_order_relaxed);
          b[slot].store(one ? -1 : 0, std::memory_order_relaxed);
        });
      }
      done.store(true);
      reader.join();
      expectEquals(torn.load(), 0, "no consistent read is torn");
      expect(consistent.load() > 0, "the reader saw stable records");
      logMessage("  tight hammer: consistent=" + juce::String(consistent.load()) +
                 " bounded=" + juce::String(bounded.load()));
    }

    beginTest("hammer: AudioNode::setMap / storedMap read whole maps");
    {
      StackNode node("s");
      timing::TimeMap A;
      A.n = 2;
      A.segs[0] = {0, 100};
      A.segs[1] = {200, 300};
      timing::TimeMap B;
      B.n = 3;
      B.segs[0] = {1000, 1100};
      B.segs[1] = {1200, 1300};
      B.segs[2] = {1400, 1500};
      auto same = [](const timing::TimeMap& x, const timing::TimeMap& y) {
        if (x.n != y.n) return false;
        for (int i = 0; i < x.n; ++i) {
          if (x.segs[i].start != y.segs[i].start) return false;
          if (x.segs[i].end != y.segs[i].end) return false;
        }
        return true;
      };
      node.setMap(A);
      std::atomic<bool> done{false};
      std::atomic<int> torn{0};
      std::thread reader([&] {
        while (!done.load(std::memory_order_relaxed)) {
          const timing::TimeMap m = node.storedMap();
          if (!same(m, A) && !same(m, B)) torn.fetch_add(1);
        }
      });
      // PACED like the real writer (the message thread writes rarely):
      // a spin between writes keeps the writer's duty cycle tiny, so
      // sixteen writes landing inside one read — the only way a read
      // comes back unchecked — do not happen; every read must then be
      // whole. A writer the OS preempts mid-write costs the reader
      // nothing (the latch: it reads the other copy) — on Windows the
      // single-copy form tore here. (A yield is not a pause on macOS
      // when the core has nothing else to run — hence the spin.)
      for (int i = 0; i < 5000; ++i) {
        node.setMap((i & 1) ? B : A);
        pace();
      }
      done.store(true);
      reader.join();
      expectEquals(torn.load(), 0, "every map read is A or B");
    }

    beginTest("hammer: StackNode island facts read as one triple");
    {
      StackNode root("island");
      std::atomic<bool> done{false};
      std::atomic<int> torn{0};
      std::thread reader([&] {
        while (!done.load(std::memory_order_relaxed)) {
          const auto f = root.readIslandFacts();
          const bool ok = (f.quantum == 1000 && f.zero == 0 &&
                           f.generation == 1) ||
                          (f.quantum == 2000 && f.zero == 500 &&
                           f.generation == 2) ||
                          (f.quantum == 0 && f.zero == 0 && f.generation == 0);
          if (!ok) torn.fetch_add(1);
        }
      });
      for (int i = 0; i < 5000; ++i) {  // paced, as above
        if (i & 1) root.setIslandFacts(2000, 500, 2);
        else root.setIslandFacts(1000, 0, 1);
        pace();
      }
      done.store(true);
      reader.join();
      expectEquals(torn.load(), 0, "every triple read is whole");
    }
  }
};

static SeqLockTests seqLockTests;

}  // namespace celestrian
