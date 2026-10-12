#pragma once

/**
 * THE TIME-CODED INPUT ("chirp") and its decoder: the instrument the
 * engine e2e `listen` assertions measure with (docs/test_harness.md
 * "Engine e2e"). Pure functions of a sample rate and samples; pinned by
 * tests/engine_bridge_tests.cc.
 *
 * The input is a slow linear frequency sweep, kF0 + kSweepHzPerSec ×
 * (seconds into the sweep), wrapping every kSweepSeconds. A recorded
 * sample then carries its own CAPTURE CLOCK as a frequency, so the
 * spectrum of any mix says which capture moments sound in it — and
 * hence which take, at which content index — whatever the level (gain,
 * pan, fades).
 *
 * decode() DECHIRPS a frame: multiplied by a reference chirp of the
 * sweep's rate, a take captured at sweep clock c becomes a steady tone
 * at kF0 + kSweepHzPerSec·c, which reads back to under two hundredths
 * of a bin. Takes captured one second apart sit kSweepHzPerSec apart:
 * 5.7 bins of a kFrame window at 44.1 kHz, fewer at a higher rate (a
 * bin spans rate² / (kFrame · kSweepHzPerSec) samples of capture clock).
 */

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <vector>

namespace celestrian::chirp {

inline constexpr double kF0 = 300.0;  // Hz at sweep clock 0
inline constexpr double kSweepHzPerSec = 61.25;
inline constexpr double kSweepSeconds = 240.0;  // 300 → 15000 Hz
/** The decode window in samples (a power of two). */
inline constexpr int kFrame = 4096;

/** The sweep at sweep clock `t` (samples), unit amplitude. */
inline double chirpAt(int64_t t, double rate) {
  const int64_t period = (int64_t)(kSweepSeconds * rate);
  if (period <= 0) return 0.0;
  const double tau = (double)(((t % period) + period) % period) / rate;
  return std::sin(2.0 * std::numbers::pi *
                  (kF0 * tau + 0.5 * kSweepHzPerSec * tau * tau));
}

/** Where input channel `channel` of `channels` starts on the sweep:
 * the channels are spread evenly over it, so every mic of a group take
 * records a clock range of its own, kSweepSeconds / channels long. */
inline int64_t channelShift(int channel, int channels, double rate) {
  return (int64_t)(kSweepSeconds * rate / (double)channels) * channel;
}

/** In-place iterative radix-2 FFT (the size a power of two). */
inline void fft(std::vector<std::complex<double>>& a) {
  const size_t n = a.size();
  for (size_t i = 1, j = 0; i < n; ++i) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }
  for (size_t len = 2; len <= n; len <<= 1) {
    const double angle = -2.0 * std::numbers::pi / (double)len;
    const std::complex<double> step(std::cos(angle), std::sin(angle));
    for (size_t i = 0; i < n; i += len) {
      std::complex<double> w(1.0, 0.0);
      for (size_t k = 0; k < len / 2; ++k) {
        const std::complex<double> u = a[i + k], v = a[i + k + len / 2] * w;
        a[i + k] = u + v;
        a[i + k + len / 2] = u - v;
        w *= step;
      }
    }
  }
}

struct Peak {
  double capture_clock;  // sweep clock sounding at the FRAME CENTRE, samples
  double level;          // ≈ the tone's amplitude
};

// A Hann-windowed tone of amplitude A peaks at A × this.
inline constexpr double kHannPeakGain = kFrame / 4.0;
// A bin counts as a peak above BOTH floors: an amplitude (silence), and
// a share of the frame's strongest bin — a loop seam inside the window
// throws sidelobes a decade down that would read as capture moments.
inline constexpr double kSilenceAmplitude = 0.01;
inline constexpr double kLeakageShare = 0.15;
// The spectrum's first and last bins are not searched (a peak needs
// both neighbours, and DC leakage sits at the bottom).
inline constexpr int kEdgeBins = 2;
// Keeps the log of an empty bin finite.
inline constexpr double kLogFloor = 1e-12;
// Three bins flatter than this have no vertex to interpolate to.
inline constexpr double kMinCurvature = 1e-12;

/** The capture clocks sounding in the kFrame samples at `x`: dechirp
 * about the frame centre, Hann, FFT, local maxima above the floors,
 * parabolic interpolation on log magnitude, then each tone read back
 * as a clock. The dechirp's sum-frequency image lands at negative
 * frequencies, so the positive half of the spectrum is clean. */
inline std::vector<Peak> decode(const float* x, double rate) {
  const int N = kFrame;
  std::vector<std::complex<double>> a((size_t)N);
  for (int i = 0; i < N; ++i) {
    const double window = 0.5 - 0.5 * std::cos(2.0 * std::numbers::pi * i / N);
    const double local = (double)(i - N / 2) / rate;  // seconds from centre
    const double reference =
        -std::numbers::pi * kSweepHzPerSec * local * local;
    a[(size_t)i] =
        std::complex<double>((double)x[i] * window, 0.0) *
        std::complex<double>(std::cos(reference), std::sin(reference));
  }
  fft(a);
  std::vector<double> mag((size_t)N / 2);
  for (int i = 0; i < N / 2; ++i) mag[(size_t)i] = std::abs(a[(size_t)i]);
  double top = 0.0;
  for (int i = kEdgeBins; i < N / 2 - kEdgeBins; ++i)
    top = std::max(top, mag[(size_t)i]);
  const double floor_mag =
      std::max(kSilenceAmplitude * kHannPeakGain, kLeakageShare * top);
  std::vector<Peak> peaks;
  for (int i = kEdgeBins; i < N / 2 - kEdgeBins; ++i) {
    const double m = mag[(size_t)i];
    if (m < floor_mag || m < mag[(size_t)i - 1] || m <= mag[(size_t)i + 1])
      continue;
    const double below = std::log(mag[(size_t)i - 1] + kLogFloor);
    const double here = std::log(m + kLogFloor);
    const double above = std::log(mag[(size_t)i + 1] + kLogFloor);
    const double curve = below - 2.0 * here + above;
    const double offset =
        std::abs(curve) > kMinCurvature ? 0.5 * (below - above) / curve : 0.0;
    const double hz = (i + offset) * rate / N;
    const double tau = (hz - kF0) / kSweepHzPerSec;  // seconds into the sweep
    if (tau < 0) continue;
    peaks.push_back({tau * rate, m / kHannPeakGain});
  }
  return peaks;
}

}  // namespace celestrian::chirp
