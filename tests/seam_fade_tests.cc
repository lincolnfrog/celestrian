/**
 * THE SEAM FADE (docs/kernel.md §2, "The seam fade"): every place the
 * render equation jumps in the source — the loop wrap, a map splice, a
 * comp cell changing takes, a one-shot's edges — is smoothed over a
 * few milliseconds, so the jump never reaches the speaker as a step.
 *
 * Pinned here: which crossfade each seam gets (the outgoing tail after
 * the seam, else the incoming lead-in before it, else a dip), the exact
 * samples each produces against an independent oracle, that everything
 * away from a seam is the kernel law untouched, that the result is a
 * pure function of t (block size never changes a sample), and that a
 * seam that used to pop no longer steps. Also the engine's PLAY-START
 * fade: a resume mid-waveform ramps in on the master. The rest of the
 * suite runs with both off (tests/test_runner.cc) so its oracles stay
 * the plain law; this file switches them on.
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/clip_node.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::contextFor;
using test_utils::NodeContext;

namespace {

/** Turns the process-wide switch on for one scope. */
struct SeamFadesOn {
  bool was = ClipNode::seam_fades_enabled.load();
  SeamFadesOn() { ClipNode::seam_fades_enabled.store(true); }
  ~SeamFadesOn() { ClipNode::seam_fades_enabled.store(was); }
};

/** The oracle's raised-cosine ramp (written out independently of the
 * engine's): the incoming weight at sample j of a len-sample fade. */
float ramp(int64_t j, int64_t len) {
  const double pi = 3.14159265358979323846;
  return (float)(0.5 - 0.5 * std::cos(pi * ((double)j + 0.5) / (double)len));
}

int64_t posMod(int64_t a, int64_t m) { return ((a % m) + m) % m; }

}  // namespace

class SeamFadeTests : public juce::UnitTest {
 public:
  SeamFadeTests() : juce::UnitTest("Seam fade (kernel section 2)") {}

  static constexpr int N = 4000;
  // The default ProcessContext rate (44.1 kHz): 176 samples.
  const int64_t F = ClipNode::seamFadeSamples(ProcessContext{}.sample_rate);

  /** A clip committed at origin 0 holding `content` (Q == 0 → the
   * immediate commit), past its commit gate. */
  static void commit(ClipNode& clip, std::vector<float>& content) {
    float* ins[] = {content.data()};
    NodeContext rec = contextFor(clip, (int)content.size());
    clip.startRecording();
    clip.process(ins, nullptr, 1, 0, rec.ctx);
    clip.stopRecording();
    NodeContext ctl = contextFor(clip, 1);
    clip.control(nullptr, 0, ctl.ctx);
  }

  /** Render [t0, t0 + n) in blocks of `block` (left channel). A
   * positive `cycle` overrides the context cycle (a one-shot's fold). */
  static std::vector<float> renderRange(ClipNode& clip, int64_t t0, int n,
                                        int block, int64_t cycle = 0) {
    std::vector<float> out((size_t)n, 0.0f);
    std::vector<float> l((size_t)block), r((size_t)block);
    for (int i = 0; i < n; i += block) {
      const int len = std::min(block, n - i);
      std::fill(l.begin(), l.end(), 0.0f);
      std::fill(r.begin(), r.end(), 0.0f);
      float* outs[] = {l.data(), r.data()};
      NodeContext nc = contextFor(clip, len, t0 + i);
      nc.ctx.is_playing = true;
      if (cycle > 0) nc.ctx.context_cycle = cycle;
      static_cast<const AudioNode&>(clip).render(outs, 2, nc.ctx);
      std::copy(l.begin(), l.begin() + len, out.begin() + i);
    }
    return out;
  }

  /** Worst |expected − got| over the range, and where. */
  void expectMatches(const std::vector<float>& got,
                     const std::vector<float>& want, const juce::String& what) {
    float worst = 0.0f;
    size_t at = 0;
    for (size_t i = 0; i < got.size(); ++i) {
      const float e = std::abs(got[i] - want[i]);
      if (e > worst) worst = e, at = i;
    }
    expect(worst < 1e-5f, what + " (worst " + juce::String(worst) + " at t=" +
                              juce::String((int64_t)at) + ")");
  }

  void runTest() override {
    SeamFadesOn on;
    std::vector<float> ramp_content(N);
    for (int i = 0; i < N; ++i) ramp_content[(size_t)i] = (float)(i + 1) / N;
    auto raw = [&](int64_t p) { return ramp_content[(size_t)p]; };
    const int T = 3 * N;

    beginTest("a trimmed region crosses into its own tail after the wrap");
    {
      ClipNode clip("trimmed");
      commit(clip, ramp_content);
      clip.setLoopPoints(1000, 3000);  // tail past 3000 and lead before 1000
      const auto got = renderRange(clip, 0, T, 64);
      std::vector<float> want((size_t)T);
      for (int64_t t = 0; t < T; ++t) {
        const int64_t h = posMod(t - 1000, 2000);
        const float plain = raw(1000 + h);
        // The incoming lands ON TIME; the outgoing runs on into its tail.
        want[(size_t)t] = h < F ? ramp(h, F) * plain +
                                      (1.0f - ramp(h, F)) * raw(3000 + h)
                                : plain;
      }
      expectMatches(got, want, "after-seam crossfade, the law elsewhere");
      expectEquals(got[999 + 2000], raw(2999),
                   "the outgoing sounds untouched up to the seam");
    }

    beginTest("a region ending at the take's end crosses in before the seam");
    {
      ClipNode clip("lead-in");
      commit(clip, ramp_content);
      clip.setLoopPoints(1000, N);  // no tail; a lead-in before 1000
      const auto got = renderRange(clip, 0, T, 64);
      std::vector<float> want((size_t)T);
      for (int64_t t = 0; t < T; ++t) {
        const int64_t h = posMod(t - 1000, N - 1000);
        const float plain = raw(1000 + h);
        const int64_t j = h - (N - 1000 - F);  // offset into the window
        want[(size_t)t] = j >= 0 ? (1.0f - ramp(j, F)) * plain +
                                       ramp(j, F) * raw(1000 - F + j)
                                 : plain;
      }
      expectMatches(got, want, "before-seam crossfade, the law elsewhere");
      expectEquals(got[1000 + (N - 1000)], raw(1000),
                   "the incoming's first sample lands exact, on time");
    }

    beginTest("a fresh loop (the take IS the loop) wraps through a dip");
    {
      ClipNode clip("fresh");
      commit(clip, ramp_content);
      const auto got = renderRange(clip, 0, T, 64);
      const int64_t h = F / 2;
      std::vector<float> want((size_t)T);
      for (int64_t t = 0; t < T; ++t) {
        const int64_t p = t % N;
        float g = 1.0f;
        if (p < h) g = ramp(p, h);                              // back in
        if (p >= N - h) g = 1.0f - ramp(p - (N - h), h);        // out
        want[(size_t)t] = g * raw(p);
      }
      expectMatches(got, want, "fade out, fade in, the law elsewhere");
    }

    beginTest("a splice crosses into the cut's tail; the wrap too");
    {
      ClipNode clip("spliced");
      commit(clip, ramp_content);
      timing::TimeMap m;
      m.n = 2;
      m.segs[0] = {0, 1000};
      m.segs[1] = {2000, 3000};
      clip.setMap(m);
      const auto got = renderRange(clip, 0, T, 100);
      std::vector<float> want((size_t)T);
      for (int64_t t = 0; t < T; ++t) {
        const int64_t h = t % 2000;
        const int64_t p = h < 1000 ? h : 2000 + (h - 1000);
        float v = raw(p);
        if (h >= 1000 && h < 1000 + F) {  // the splice: 999 → 2000
          const int64_t j = h - 1000;
          v = ramp(j, F) * v + (1.0f - ramp(j, F)) * raw(1000 + j);
        } else if (h < F) {  // the wrap: 2999 → 0, tail from 3000
          v = ramp(h, F) * v + (1.0f - ramp(h, F)) * raw(3000 + h);
        }
        want[(size_t)t] = v;
      }
      expectMatches(got, want, "both seams, the law elsewhere");
    }

    beginTest("inner-adjacent segments are no seam at all");
    {
      ClipNode clip("adjacent");
      commit(clip, ramp_content);
      timing::TimeMap m;
      m.n = 2;
      m.segs[0] = {1000, 2000};
      m.segs[1] = {2000, 3000};  // continuous in the source
      clip.setMap(m);
      ClipNode single("single");
      commit(single, ramp_content);
      single.setLoopPoints(1000, 3000);
      expectMatches(renderRange(clip, 0, T, 64),
                    renderRange(single, 0, T, 64),
                    "the same samples as the one window");
    }

    beginTest("a comp crosses takes at a cell, from the outgoing take's tail");
    {
      ClipNode clip("comp");
      commit(clip, ramp_content);
      std::vector<float> other(N);
      for (int i = 0; i < N; ++i) other[(size_t)i] = -0.5f - (float)i / (4 * N);
      juce::AudioBuffer<float> take2(1, N);
      take2.copyFrom(0, 0, other.data(), N);
      clip.appendLoadedTake(take2);
      clip.setCompCells({0, 1}, N / 2);  // take 1, then take 2
      const auto got = renderRange(clip, 0, T, 64);
      const int64_t h = F / 2;
      std::vector<float> want((size_t)T);
      for (int64_t t = 0; t < T; ++t) {
        const int64_t p = t % N;
        float v = p < N / 2 ? raw(p) : other[(size_t)p];
        if (p >= N / 2 && p < N / 2 + F) {  // take 1's tail runs on
          const int64_t j = p - N / 2;
          v = ramp(j, F) * v + (1.0f - ramp(j, F)) * raw(p);
        } else if (p < h) {  // the wrap: neither take extends — a dip
          v *= ramp(p, h);
        } else if (p >= N - h) {
          v *= 1.0f - ramp(p - (N - h), h);
        }
        want[(size_t)t] = v;
      }
      expectMatches(got, want, "the cell seam and the wrap");
    }

    beginTest("a one-shot fades out into its rest and back in at its top");
    {
      ClipNode clip("shot");
      commit(clip, ramp_content);
      clip.period_from_context_.store(true);
      const int64_t cycle = 2 * N;
      const auto got = renderRange(clip, 0, 2 * (int)cycle, 64, cycle);
      std::vector<float> want((size_t)(2 * cycle));
      for (int64_t t = 0; t < 2 * cycle; ++t) {
        const int64_t p = t % cycle;
        float v = p < N ? raw(p) : 0.0f;
        if (p < F) v *= ramp(p, F);  // out of the rest: silence runs on
        if (p >= N - F && p < N) v *= 1.0f - ramp(p - (N - F), F);  // into it
        want[(size_t)t] = v;
      }
      expectMatches(got, want, "the shot's edges, silence in the rest");
    }

    beginTest("pure in t: the block size never changes a sample");
    {
      ClipNode clip("blocks");
      commit(clip, ramp_content);
      timing::TimeMap m;
      m.n = 3;
      m.segs[0] = {100, 900};
      m.segs[1] = {1500, 2100};
      m.segs[2] = {3000, N};
      clip.setMap(m);
      const auto ref = renderRange(clip, 0, T, 1);
      for (int block : {7, 64, 441, 4096}) {
        const auto got = renderRange(clip, 0, T, block);
        bool same = true;
        for (size_t i = 0; i < got.size() && same; ++i) same = got[i] == ref[i];
        expect(same, "block " + juce::String(block) + " == block 1, bit-exact");
      }
    }

    beginTest("the pop is gone: a loop cut mid-cycle steps no more than it swings");
    {
      // 440 Hz whose loop ends mid-cycle: the raw wrap jumps by ~1.
      std::vector<float> sine(N);
      const double w = 2.0 * 3.14159265358979323846 * 440.0 / 44100.0;
      for (int i = 0; i < N; ++i) sine[(size_t)i] = (float)std::sin(w * i + 0.32);
      ClipNode clip("sine");
      commit(clip, sine);
      auto worstStep = [&](const std::vector<float>& s) {
        float worst = 0.0f;
        for (size_t i = 1; i < s.size(); ++i)
          worst = std::max(worst, std::abs(s[i] - s[i - 1]));
        return worst;
      };
      const float swing = (float)w;  // the sine's own steepest step
      const float faded = worstStep(renderRange(clip, N - 500, 1000, 64));
      ClipNode::seam_fades_enabled.store(false);
      const float popped = worstStep(renderRange(clip, N - 500, 1000, 64));
      ClipNode::seam_fades_enabled.store(true);
      expect(popped > 0.4f, "the bare wrap steps (" + juce::String(popped) + ")");
      expect(faded < 1.5f * swing, "the faded wrap steps " + juce::String(faded) +
                                       " — within the sine's own " +
                                       juce::String(swing) + " (×1.5)");
    }

    beginTest("a segment shorter than two fades shortens the fade to fit");
    {
      ClipNode clip("short");
      commit(clip, ramp_content);
      timing::TimeMap m;
      m.n = 2;
      m.segs[0] = {0, 100};  // 100 < 2F: the fade is 50
      m.segs[1] = {2000, 3000};
      clip.setMap(m);
      const auto got = renderRange(clip, 0, 2200, 64);
      const int64_t f = 50;
      for (int64_t t = 0; t < 2200; ++t) {
        const int64_t h = t % 1100;
        const int64_t p = h < 100 ? h : 2000 + (h - 100);
        float v = raw(p);
        if (h >= 100 && h < 100 + f) {
          const int64_t j = h - 100;
          v = ramp(j, f) * v + (1.0f - ramp(j, f)) * raw(100 + j);
        } else if (h < f) {
          v = ramp(h, f) * v + (1.0f - ramp(h, f)) * raw(3000 + h);
        }
        if (std::abs(got[(size_t)t] - v) > 1e-5f) {
          expect(false, "t=" + juce::String(t) + ": " + juce::String(got[(size_t)t]) +
                            " != " + juce::String(v));
          break;
        }
      }
    }

    beginTest("the play-start fade: a resume mid-waveform ramps in on the master");
    {
      // This case is about the start; keep the seams bare so the only
      // shaping in the window is the start ramp.
      ClipNode::seam_fades_enabled.store(false);
      scenario::Island is;
      const juce::String c = is.record(20000);
      is.drive(3000);  // somewhere mid-loop
      is.refresh();
      auto resume = [&](bool fade) {
        AudioEngine::play_start_fade_enabled.store(fade);
        is.engine.togglePlayback();  // pause
        is.drive(2 * scenario::BLOCK);
        expect(!is.engine.isPlaying(), "paused");
        is.engine.togglePlayback();  // play
        std::vector<std::pair<int64_t, float>> out;
        is.drive(2 * scenario::BLOCK, &out);
        AudioEngine::play_start_fade_enabled.store(false);
        return out;
      };
      const auto faded = resume(true);
      int bad = 0;
      for (size_t i = 0; i < faded.size(); ++i) {
        const float g = (int64_t)i < F ? ramp((int64_t)i, F) : 1.0f;
        if (std::abs(faded[i].second - g * is.loopVal(c, faded[i].first)) > 1e-6f)
          ++bad;
      }
      expectEquals(bad, 0, "g(i) · the loop law, then the law untouched");
      expect(faded.front().second < 0.01f * is.loopVal(c, faded.front().first),
             "the first sample after the start is near silence");

      const auto bare = resume(false);
      expect(bare.front().second > 1e-3f,
             "(the start really is mid-waveform: bare, it steps to " +
                 juce::String(bare.front().second) + ")");
      expectEquals(bare.front().second, is.loopVal(c, bare.front().first),
                   "switched off, the start is the bare law");

      // A second start after a pause fades again (the ramp re-arms).
      const auto again = resume(true);
      expect(again.front().second < 0.01f * is.loopVal(c, again.front().first),
             "every start fades, not just the first");
      ClipNode::seam_fades_enabled.store(true);
    }
  }
};

static SeamFadeTests seamFadeTests;

}  // namespace celestrian
