/**
 * THE HEADLESS ENGINE SERVER — the real engine, no window, no device
 * (docs/test_harness.md "Engine e2e").
 *
 * AudioEngine + ProjectManager + PluginHostService driven by a
 * SYNTHETIC audio clock (a thread pacing device-sized blocks of a
 * generated input through the one callback a device would call), with
 * the bridge table (src/bridge_dispatch.h) served over HTTP and ui/
 * served as static files from the same origin. Load
 * `http://localhost:PORT/index.html?engine=true` and the real UI runs
 * against the real engine; Playwright does exactly that
 * (ui/playwright.engine.config.js, specs in ui/e2e_engine).
 *
 *   POST /call     {name, args[]}   → {result}        (the bridge table)
 *   POST /control  {op, ...}        → op-specific JSON
 *   GET  /<path>                    → ui/<path>       (index.html default)
 *
 * The control ops make a run deterministic: status · pause · resume ·
 * advance{samples} · input{kind, freq, gain} · truth · listen{samples,
 * hop} · reset · quit. `truth` and `listen` both answer what SOUNDS:
 * truth solos each clip and listens for level; listen decodes the mix
 * itself, from the chirp input (chirp_codec.h).
 *
 * Threads, as in the app: bridge handlers run on the MESSAGE thread (an
 * HTTP thread marshals each call there and waits); the clock thread is
 * THE audio thread; `advance`, `truth` and `listen` run blocks from an
 * HTTP thread. One mutex serialises every callback and guards the
 * clocks and the input choice.
 *
 *   CelestrianHeadless [--port 8091] [--ui-dir DIR] [--projects-dir DIR]
 *                      [--input sine|ramp|chirp|silence] [--freq 220]
 *                      [--gain 0.5] [--inputs N] [--block 512] [--paused]
 */

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <iostream>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

#include "../audio_engine.h"
#include "../bridge_dispatch.h"
#include "../clip_node.h"
#include "../period_law.h"
#include "../plugin_host_service.h"
#include "../plugin_scan_worker.h"
#include "../project_manager.h"
#include "chirp_codec.h"
#include "http_server.h"

namespace {

struct Options {
  int port = 8091;
  juce::File ui_dir;
  juce::File projects_dir;
  juce::String input = "sine";
  double freq = 220.0;
  double gain = 0.5;
  int block = 512;
  int inputs = 1;  // input channels; with the chirp each carries its own sweep
  bool paused = false;
};

class StdoutLogger : public juce::Logger {
  void logMessage(const juce::String& m) override {
    std::cout << m << std::endl;
  }
};

inline int64_t posmod(int64_t a, int64_t m) { return m > 0 ? ((a % m) + m) % m : 0; }

/** A sample-valued fact of a getGraphState record (0 when absent). */
int64_t samplesOf(const juce::var& record, const char* key) {
  return (int64_t)(double)record.getProperty(key, 0);
}

/** THE ROOT'S FRAME TOP, from the island zero: the root's origin while
 * a song anchors it (docs/frame.md §4), else the zero itself (0). The
 * frame the view seats a root song on and its gates fold on. */
int64_t rootTopFromZero(const juce::var& state) {
  return (bool)state.getProperty("anchored", false)
             ? samplesOf(state, "origin") - samplesOf(state, "islandZero")
             : 0;
}

std::atomic<bool> g_quit{false};

/** Run `fn` on the message thread and wait for it (an HTTP thread's
 * one way into the engine — every bridge verb is message-thread-only). */
void onMessageThread(std::function<void()> fn) {
  if (juce::MessageManager::getInstance()->isThisTheMessageThread()) {
    fn();
    return;
  }
  juce::WaitableEvent done;
  juce::MessageManager::callAsync([&] {
    fn();
    done.signal();
  });
  if (!done.wait(30000))
    juce::Logger::writeToLog("headless: message-thread call timed out");
}

// ---------------------------------------------------------------------------
// The host: engine, services, the bridge table, the synthetic clock.
// ---------------------------------------------------------------------------
class Host {
 public:
  explicit Host(const Options& o)
      : opts_(o),
        plugins_(o.projects_dir.getChildFile("plugin-host")),
        rate_(engine_.currentSampleRateOrFallback()) {
    projects_.setRootForTest(o.projects_dir);
    const celestrian::bridge::Services services{engine_, projects_, plugins_};
    for (auto& m : celestrian::bridge::engineMethods(services)) {
      handlers_[m.name] = m.handler;
    }
    // Window-bound verbs, stood in: no chooser, no editor, no pointer —
    // each answers what the app shell answers when it refuses.
    auto refuse = [](juce::var v) {
      return [v](const juce::Array<juce::var>&, celestrian::bridge::Completion done) {
        done(v);
      };
    };
    handlers_["bounceWithDialog"] = refuse(false);
    handlers_["importAudioWithDialog"] = refuse(false);
    handlers_["chooseProjectsRoot"] = refuse(juce::String());
    handlers_["warpPointer"] = refuse(false);
    handlers_["openPluginEditor"] = refuse(false);
    engine_.setOnSessionLoaded(
        [services] { celestrian::bridge::revivePlaceholders(services); });
    paused_.store(o.paused);
    in_.resize((size_t)std::max(1, o.inputs), std::vector<float>((size_t)o.block));
    out_l_.resize((size_t)o.block);
    out_r_.resize((size_t)o.block);
    recordBoot();
  }

  AudioEngine& engine() { return engine_; }
  celestrian::ProjectManager& projects() { return projects_; }
  const Options& opts() const { return opts_; }
  bool paused() const { return paused_.load(); }
  void setPaused(bool p) { paused_.store(p); }
  double rate() const { return rate_; }

  bool has(const juce::String& name) const { return handlers_.count(name) > 0; }

  /** The bridge call, marshalled to the message thread from an HTTP
   * thread, which waits here for its completion — a handler may complete
   * later, from another message-thread callback (a plugin still
   * instantiating). The answer is shared with the completion, so one
   * that arrives after the wait gave up lands nowhere. */
  juce::var call(const juce::String& name, const juce::Array<juce::var>& args,
                 bool& found) {
    auto it = handlers_.find(name);
    found = it != handlers_.end();
    if (!found) return {};
    struct Pending {
      juce::WaitableEvent completed;
      juce::var result;
    };
    const auto pending = std::make_shared<Pending>();
    onMessageThread([&] {
      it->second(args, [pending](juce::var r) {
        pending->result = std::move(r);
        pending->completed.signal();
      });
    });
    if (!pending->completed.wait(kCompletionTimeoutMs)) {
      juce::Logger::writeToLog("headless: " + name + " was never completed");
      return {};
    }
    return pending->result;
  }

  /** Render `total` samples through the device callback (the audio
   * thread's job; serialised with the clock thread). Appends channel 0
   * to `capture` when given. */
  void render(int64_t total, std::vector<float>* capture = nullptr) {
    std::lock_guard<std::mutex> lock(callback_mutex_);
    const int block = opts_.block;
    std::vector<const float*> ins;
    for (auto& ch : in_) ins.push_back(ch.data());
    float* outs[] = {out_l_.data(), out_r_.data()};
    int64_t remaining = total;
    while (remaining > 0) {
      const int n = (int)std::min<int64_t>(remaining, block);
      // THE SWEEP CLOCK (see sweep_clock_): spent only while a take is
      // live, a guard second ahead of every arm.
      const bool live = engine_.hasActiveTake();
      if (live && !sweep_live_) sweep_clock_ += (int64_t)rate_;
      sweep_live_ = live;
      fillInput(n);
      engine_.audioDeviceIOCallbackWithContext(ins.data(), (int)ins.size(), outs, 2,
                                               n, {});
      if (capture != nullptr)
        capture->insert(capture->end(), out_l_.begin(), out_l_.begin() + n);
      input_clock_ += n;
      if (live) sweep_clock_ += n;
      remaining -= n;
    }
  }

  void setInput(const juce::String& kind, double freq, double gain) {
    std::lock_guard<std::mutex> lock(callback_mutex_);
    input_kind_ = kind;
    if (freq > 0) freq_ = freq;
    if (gain >= 0) gain_ = gain;
  }

  int64_t inputClock() const {
    std::lock_guard<std::mutex> lock(callback_mutex_);
    return input_clock_;
  }

  /** Facts the specs steer by. `islandPos` is the raw clock
   * zero-relative and unwrapped (the engine's contract), so the island
   * phase is `islandPos mod cycle`. */
  juce::var status() {
    auto* o = new juce::DynamicObject();
    onMessageThread([&] {
      const juce::var st = engine_.getGraphState();
      o->setProperty("quantum", (double)samplesOf(st, "quantum"));
      o->setProperty("zero", (double)samplesOf(st, "islandZero"));
      o->setProperty("islandPos", (double)samplesOf(st, "islandPos"));
      o->setProperty("masterPos", (double)samplesOf(st, "masterPos"));
      o->setProperty("cycle", (double)islandCycle(st));
      o->setProperty("isPlaying", (bool)st.getProperty("isPlaying", false));
      o->setProperty("rootId", st.getProperty("id", ""));
    });
    o->setProperty("paused", paused_.load());
    o->setProperty("rate", rate_);
    o->setProperty("block", opts_.block);
    {
      // The clocks and the input choice are the callback's: read
      // between two blocks, never mid-render.
      std::lock_guard<std::mutex> lock(callback_mutex_);
      o->setProperty("clock", (double)input_clock_);
      o->setProperty("sweepClock", (double)sweep_clock_);
      o->setProperty("input", input_kind_);
    }
    return juce::var(o);
  }

  /** THE AUDIBLE TRUTH: for every clip, which Q cells of the island
   * cycle it sounds in — the engine solos it and listens to one cycle.
   * Cells are laid out from the root's frame top (the ruler). Runs
   * with the clock paused; the transport advances by
   * (clips × (cycle + 3 blocks)). */
  juce::var truth() {
    const bool was_paused = paused_.exchange(true);
    juce::var st;
    onMessageThread([&] {
      if (!engine_.isPlaying()) engine_.togglePlayback();
      st = engine_.getGraphState();
    });
    const int64_t q = samplesOf(st, "quantum");
    const int64_t cycle = islandCycleOnMessageThread(st);
    auto* doc = new juce::DynamicObject();
    doc->setProperty("quantum", (double)q);
    doc->setProperty("cycle", (double)cycle);
    auto* rows = new juce::DynamicObject();
    if (q > 0 && cycle > 0 && cycle % q == 0) {
      const int cells = (int)(cycle / q);
      doc->setProperty("cycleQ", cells);
      std::vector<juce::String> clips;
      collectClips(st, clips);
      for (const auto& id : clips) {
        juce::Array<juce::var> solo_args;
        solo_args.add(id);
        bool found = false;
        call("toggleSolo", solo_args, found);
        // The phase of the first rendered sample: the published
        // islandPos folded from the root's frame top.
        int64_t pos0 = 0;
        onMessageThread([&] {
          const juce::var s = engine_.getGraphState();
          pos0 = samplesOf(s, "islandPos") - rootTopFromZero(s);
        });
        std::vector<float> out;
        // The solo lands as a mute RAMP on every other lane (≤ one
        // fade-step per block): the first blocks of the render still
        // carry their tails, and a cell centre falling there would read
        // as this clip sounding. Skip them; the extra length keeps every
        // phase covered after the skip.
        const int64_t settle = 2 * (int64_t)opts_.block;
        render(cycle + settle + opts_.block, &out);
        juce::Array<juce::var> row;
        for (int c = 0; c < cells; ++c) {
          // The cell's centre in the island frame, ± kCellCentreReach:
          // the clip's own signal or exact silence (a gate's ramp is
          // far from a cell centre).
          const int64_t want = c * q + q / 2;
          float peak = 0.0f;
          for (int64_t k = settle; k < (int64_t)out.size(); ++k) {
            const int64_t ph = posmod(pos0 + k, cycle);
            if (std::llabs(ph - want) <= kCellCentreReach)
              peak = std::max(peak, std::abs(out[(size_t)k]));
          }
          row.add(peak > kSoundsAbove);
        }
        rows->setProperty(id, row);
        call("toggleSolo", solo_args, found);
      }
    } else {
      doc->setProperty("cycleQ", 0);
    }
    doc->setProperty("truth", juce::var(rows));
    paused_.store(was_paused);
    return juce::var(doc);
  }

  // --- THE SPECTRAL LISTENER (chirp input, chirp_codec.h) ---

  struct TakeMap {
    juce::String id;
    int take = 0;
    double capture_clock = 0;  // sweep clock of content[0]
    int64_t duration = 0;
  };

  /** Where every take of every clip was captured, decoded from the
   * take buffers themselves (message thread). */
  std::vector<TakeMap> clipMap(const juce::var& st) {
    std::vector<TakeMap> out;
    std::vector<juce::String> ids;
    collectClips(st, ids);
    for (const auto& id : ids) {
      auto* clip = dynamic_cast<celestrian::ClipNode*>(engine_.findNodeByUuidForTest(id));
      if (clip == nullptr) continue;
      const int active = (int)celestrian::bridge::findNodeVar(st, id).getProperty(
          "activeTake", 0);
      for (int k = 0; k < clip->takeCount(); ++k) {
        // The ACTIVE take is what renders: its live content buffer (a
        // Q13 lock-collapse splices it; the take store may still hold
        // the pre-splice copy). Other takes come from the store.
        const juce::AudioBuffer<float>* buf =
            k == active ? &clip->getAudioBuffer() : clip->takeBuffer(k);
        if (buf == nullptr || buf->getNumSamples() < kFrame) continue;
        const auto peaks = celestrian::chirp::decode(buf->getReadPointer(0), rate_);
        if (peaks.empty()) continue;
        // The strongest peak at the first frame's centre → buffer[0].
        const celestrian::chirp::Peak* best = &peaks[0];
        for (const auto& p : peaks)
          if (p.level > best->level) best = &p;
        // CONTENT vs BUFFER (Q13 lock-collapse, ClipNode::content_base_):
        // a collapsed definer keeps its whole buffer and reads from a
        // base offset with a shorter published duration. Report in the
        // CONTENT frame the render law speaks: content[0] = buffer[base].
        const int64_t base = k == active ? clip->getContentBase() : 0;
        const int64_t duration = k == active ? clip->getIntrinsicDuration()
                                             : (int64_t)buf->getNumSamples();
        out.push_back({id, k,
                       best->capture_clock - kFrame / 2.0 + (double)base,
                       duration > 0 ? duration : (int64_t)buf->getNumSamples()});
      }
    }
    return out;
  }

  /** LISTEN: render `samples` (default one island cycle) and report, per
   * frame, which clip/take sounds at which content index — the mix
   * decoded, no soloing. Frames are `hop` apart; `pos` is the frame
   * centre, zero-relative (islandPos — the specs recover the absolute
   * clock as zero + pos); `phase` is its fold on the cycle from the
   * root's frame top. */
  juce::var listen(int64_t samples, int64_t hop) {
    const bool was_paused = paused_.exchange(true);
    juce::var st;
    onMessageThread([&] {
      if (!engine_.isPlaying()) engine_.togglePlayback();
      st = engine_.getGraphState();
    });
    const int64_t pos0 = samplesOf(st, "islandPos");
    const int64_t top_from_zero = rootTopFromZero(st);
    const int64_t cycle = islandCycleOnMessageThread(st);
    if (samples <= 0) samples = cycle > 0 ? cycle : (int64_t)rate_;
    if (hop <= 0) hop = kFrame;
    std::vector<TakeMap> map;
    onMessageThread([&] { map = clipMap(st); });

    std::vector<float> out;
    render(samples + kFrame, &out);

    auto* doc = new juce::DynamicObject();
    doc->setProperty("rate", rate_);
    doc->setProperty("quantum", (double)samplesOf(st, "quantum"));
    doc->setProperty("cycle", (double)cycle);
    doc->setProperty("zero", (double)samplesOf(st, "islandZero"));
    doc->setProperty("frame", kFrame);
    doc->setProperty("hop", (double)hop);
    juce::Array<juce::var> frames;
    const double half_frame = kFrame / 2.0;
    for (int64_t s = 0; s + kFrame <= (int64_t)out.size() && s < samples;
         s += hop) {
      auto* f = new juce::DynamicObject();
      const int64_t centre = pos0 + s + kFrame / 2;
      f->setProperty("pos", (double)centre);
      f->setProperty("phase",
                     (double)posmod(centre - top_from_zero, cycle > 0 ? cycle : 1));
      juce::Array<juce::var> heard, unknown;
      for (const auto& p : celestrian::chirp::decode(out.data() + s, rate_)) {
        // Attribution: the take whose capture range holds the clock.
        // Takes recorded back to back have ADJACENT ranges, so an exact
        // hit wins; only when nothing holds it exactly does a half-frame
        // tolerance (the decode's own blur at a range edge) apply.
        const TakeMap* hit = nullptr;
        for (const double reach : {0.0, half_frame}) {
          for (const auto& m : map) {
            const double inner = p.capture_clock - m.capture_clock;
            if (hit == nullptr && inner >= -reach &&
                inner < (double)m.duration + reach) {
              hit = &m;
            }
          }
        }
        if (hit != nullptr) {
          const double inner = p.capture_clock - hit->capture_clock;
          auto* h = new juce::DynamicObject();
          h->setProperty("id", hit->id);
          h->setProperty("take", hit->take);
          h->setProperty("inner", std::max(0.0, std::min((double)hit->duration - 1, inner)));
          h->setProperty("level", p.level);
          heard.add(juce::var(h));
        } else {
          unknown.add(p.capture_clock);
        }
      }
      f->setProperty("heard", heard);
      f->setProperty("unknown", unknown);
      frames.add(juce::var(f));
    }
    doc->setProperty("frames", frames);
    auto* clips = new juce::DynamicObject();
    for (const auto& m : map) {
      juce::var existing = clips->getProperty(m.id);
      juce::Array<juce::var> takes;
      if (auto* arr = existing.getArray()) takes = *arr;
      auto* t = new juce::DynamicObject();
      t->setProperty("take", m.take);
      t->setProperty("captureClock", m.capture_clock);
      t->setProperty("duration", (double)m.duration);
      takes.add(juce::var(t));
      clips->setProperty(m.id, takes);
    }
    doc->setProperty("clips", juce::var(clips));
    paused_.store(was_paused);
    return juce::var(doc);
  }

  /** Back to the session a fresh boot serves, whatever the last spec
   * left behind:
   *  - a live take ends first (settleTakes) — nothing loads under one;
   *  - THE PROJECT IS CLOSED as the spec left it, before anything below
   *    changes the session its folder mirrors: the next spec starts
   *    unborn, and nothing it does reaches that folder;
   *  - the root lets go of what no session carries: its solo, its MIDI
   *    arm, its scope, a new name;
   *  - THE BOOT BUNDLE loads over the rest: every node gone, the master
   *    rack and fader as built, no song, no Q, no hand-off — and, a load
   *    being the engine's one way to start a history afresh, nothing to
   *    undo;
   *  - track templates saved since boot are removed.
   * The transport is left RUNNING, as every spec expects, and the input
   * choice stands. Not reset: the clock (kernel.md: never), and what
   * earlier specs left on disk (project folders, session templates).
   * False when the boot bundle would not load. */
  bool reset() {
    settleTakes();
    bool loaded = false;
    onMessageThread([&] {
      engine_.tick();  // a take the audio thread just settled is logged
      projects_.closeProject();
      const juce::var st = engine_.getGraphState();
      const juce::String root = st.getProperty("id", "").toString();
      if ((bool)st.getProperty("isSoloed", false)) engine_.toggleSolo(root);
      engine_.setMidiArmed(root, false);
      engine_.setEffectScope(root, false);
      engine_.renameNode(root, boot_root_name_);
      loaded = engine_.loadSession(bootBundle().getFullPathName());
      if (!loaded) {
        juce::Logger::writeToLog(
            "headless: reset could not load the boot bundle - the session "
            "stands");
      }
      for (const auto& file : templateFiles()) {
        if (!boot_templates_.contains(file.getFileName())) file.deleteFile();
      }
      if (!engine_.isPlaying()) engine_.togglePlayback();
      engine_.tick();
    });
    // A fresh sweep for the next spec.
    std::lock_guard<std::mutex> lock(callback_mutex_);
    input_clock_ = 0;
    sweep_clock_ = 0;
    sweep_live_ = false;
    return loaded;
  }

 private:
  /** Every live take ends, through the engine's own stop: one on the
   * root reaches them all — a pending arm is cancelled there and then; a
   * capturing take is ended by the audio thread, a first take at its
   * next block and any other at its next boundary, at most
   * ClipNode::stopRun(Q) of clock away, which is run here. (The engine
   * has no verb that abandons a capturing take.) */
  void settleTakes() {
    int64_t budget = 0;
    onMessageThread([&] {
      if (!engine_.hasActiveTake()) return;
      const juce::var st = engine_.getGraphState();
      engine_.stopRecordingInNode(st.getProperty("id", "").toString());
      budget = celestrian::ClipNode::stopRun(samplesOf(st, "quantum")) +
               kSettleSlackBlocks * (int64_t)opts_.block;
    });
    for (int64_t run = 0; run < budget && engine_.hasActiveTake();
         run += opts_.block) {
      render(opts_.block);
    }
  }

  juce::File bootBundle() const {
    return opts_.projects_dir.getChildFile(kBootBundleName);
  }
  juce::Array<juce::File> templateFiles() const {
    return projects_.trackTemplatesRoot().findChildFiles(
        juce::File::findFiles, false, "*.json");
  }
  /** What reset() goes back to, taken from the engine as constructed:
   * its session as a bundle, the root's name, and the template files
   * already in the library (a scratch projects directory has none). */
  void recordBoot() {
    if (!engine_.saveSession(bootBundle().getFullPathName())) {
      juce::Logger::writeToLog(
          "headless: the boot bundle could not be written - reset will fail");
    }
    boot_root_name_ =
        engine_.getGraphState().getProperty("name", "").toString();
    for (const auto& file : templateFiles()) {
      boot_templates_.add(file.getFileName());
    }
  }

  static constexpr int kFrame = celestrian::chirp::kFrame;
  // truth(): a cell is judged within this many samples of its centre,
  // and sounds when the peak there is above this level.
  static constexpr int64_t kCellCentreReach = 128;
  static constexpr float kSoundsAbove = 1.0e-6f;
  // The ramp input's period: the scenario harness's sawtooth
  // (tests/scenario_utils.h), every sample encoding its own clock.
  static constexpr int64_t kRampPeriod = int64_t{1} << 20;
  // The boot bundle (recordBoot), beside Projects/ — never listed as one.
  static constexpr const char* kBootBundleName = "headless-reset";
  // settleTakes: blocks of clock past a take's stop run — the one that
  // takes the stop up, the one that crosses the boundary, and two spare.
  static constexpr int kSettleSlackBlocks = 4;
  // call(): how long an HTTP thread waits for a handler's completion.
  static constexpr int kCompletionTimeoutMs = 30000;

  void fillInput(int n) {
    const int channels = (int)in_.size();
    for (int ch = 0; ch < channels; ++ch) {
      // Sine and ramp are the same on every channel; the chirp gives
      // each its own stretch of the sweep.
      const int64_t shift = celestrian::chirp::channelShift(ch, channels, rate_);
      float* dst = in_[(size_t)ch].data();
      for (int i = 0; i < n; ++i) {
        const int64_t t = input_clock_ + i;
        float v = 0.0f;
        if (input_kind_ == "sine") {
          v = (float)(gain_ * std::sin(2.0 * juce::MathConstants<double>::pi *
                                       freq_ * (double)t / rate_));
        } else if (input_kind_ == "chirp") {
          v = (float)(gain_ * celestrian::chirp::chirpAt(sweep_clock_ + i + shift, rate_));
        } else if (input_kind_ == "ramp") {
          v = 0.5f * (float)((double)posmod(t, kRampPeriod) / (double)kRampPeriod);
        }
        dst[i] = v;
      }
    }
  }

  void collectClips(const juce::var& node, std::vector<juce::String>& out) {
    if (node.getProperty("type", "").toString() == "clip") {
      if ((double)node.getProperty("duration", 0) > 0)
        out.push_back(node.getProperty("id", "").toString());
      return;
    }
    if (auto* kids = node.getProperty("nodes", juce::var()).getArray())
      for (const auto& k : *kids) collectClips(k, out);
  }

  /** The audible island cycle by THE PERIOD LAW over the live tree
   * (message thread), judged against the island Q (drifting nodes
   * extend nothing, Q22). */
  int64_t islandCycle(const juce::var& st) {
    auto* root = engine_.findNodeByUuidForTest(st.getProperty("id", "").toString());
    if (root == nullptr) return 0;
    const int64_t q = samplesOf(st, "quantum");
    return celestrian::period_law::islandCycle(
        celestrian::period_law::TreeProvider{q}, root, q, (int64_t)rate_);
  }
  int64_t islandCycleOnMessageThread(const juce::var& st) {
    int64_t c = 0;
    onMessageThread([&] { c = islandCycle(st); });
    return c;
  }

  Options opts_;
  AudioEngine engine_;
  celestrian::ProjectManager projects_{engine_};
  celestrian::PluginHostService plugins_;
  std::map<juce::String, celestrian::bridge::Handler> handlers_;
  double rate_;
  std::atomic<bool> paused_{false};
  // Message thread: what reset() goes back to (recordBoot).
  juce::String boot_root_name_;
  juce::StringArray boot_templates_;

  // Everything below is the callback's, under callback_mutex_.
  mutable std::mutex callback_mutex_;
  std::vector<std::vector<float>> in_;  // one buffer per input channel
  std::vector<float> out_l_, out_r_;
  int64_t input_clock_ = 0;
  // THE SWEEP CLOCK: where on the chirp's sweep the input reads. It
  // advances only while a take is LIVE (armed or capturing — the sweep
  // is spent on recordings, never on playback or a listen, so a spec's
  // whole session fits one sweep) and jumps a GUARD second at every arm
  // (abutting capture ranges would let a frame that straddles one
  // take's loop seam decode a hair into the next take's range).
  // `reset` restarts it.
  int64_t sweep_clock_ = 0;
  bool sweep_live_ = false;  // the previous block's live state (the arm edge)
  juce::String input_kind_ = "sine";
  double freq_ = 220.0, gain_ = 0.5;
};

// ---------------------------------------------------------------------------
// The clock thread: real-time pacing of device-sized blocks.
// ---------------------------------------------------------------------------
class ClockThread : public juce::Thread {
 public:
  explicit ClockThread(Host& h) : juce::Thread("engine clock"), host_(h) {}
  void run() override {
    using clock = std::chrono::steady_clock;
    const auto per_block = std::chrono::duration_cast<clock::duration>(
        std::chrono::duration<double>((double)host_.opts().block / host_.rate()));
    auto next = clock::now();
    while (!threadShouldExit()) {
      if (host_.paused()) {
        wait(5);
        next = clock::now();
        continue;
      }
      host_.render(host_.opts().block);
      next += per_block;
      std::this_thread::sleep_until(next);
    }
  }

 private:
  Host& host_;
};

// ---------------------------------------------------------------------------
// Housekeeping the app's component timer does: engine + project ticks.
// ---------------------------------------------------------------------------
class Heartbeat : public juce::Timer {
 public:
  explicit Heartbeat(Host& h) : host_(h) { startTimer(1000); }
  void timerCallback() override {
    host_.engine().tick();
    host_.projects().tick();
  }

 private:
  Host& host_;
};

// ---------------------------------------------------------------------------
// The routes (called from the HTTP server's connection threads; the
// host's methods serialise themselves).
// ---------------------------------------------------------------------------
juce::var control(Host& host, const juce::var& body) {
  const juce::String op = body.getProperty("op", "").toString();
  auto ok = [](bool v = true) {
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", v);
    return juce::var(o);
  };
  if (op == "status") return host.status();
  if (op == "pause") {
    host.setPaused(true);
    return ok();
  }
  if (op == "resume") {
    host.setPaused(false);
    return ok();
  }
  if (op == "advance") {
    const int64_t n = samplesOf(body, "samples");
    if (n > 0) host.render(n);
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", true);
    o->setProperty("clock", (double)host.inputClock());
    return juce::var(o);
  }
  if (op == "input") {
    host.setInput(body.getProperty("kind", "sine").toString(),
                  (double)body.getProperty("freq", 0.0),
                  body.hasProperty("gain") ? (double)body.getProperty("gain", 0.5) : -1.0);
    return ok();
  }
  if (op == "truth") return host.truth();
  if (op == "listen")
    return host.listen(samplesOf(body, "samples"), samplesOf(body, "hop"));
  if (op == "reset") return ok(host.reset());
  if (op == "quit") {
    g_quit.store(true);
    return ok();
  }
  juce::Logger::writeToLog("headless: unknown control op " + op);
  return ok(false);
}

celestrian::http::Response route(Host& host, const juce::File& ui_dir,
                     const celestrian::http::Request& request) {
  if (request.method == "POST" && request.path == "/call") {
    const juce::var body = juce::JSON::parse(request.body);
    const juce::String name = body.getProperty("name", "").toString();
    juce::Array<juce::var> args;
    if (auto* a = body.getProperty("args", juce::var()).getArray()) args = *a;
    bool found = false;
    const juce::var result = host.call(name, args, found);
    if (!found) {
      juce::Logger::writeToLog("headless: unknown bridge method " + name);
      return celestrian::http::statusOnly(404);
    }
    auto* o = new juce::DynamicObject();
    o->setProperty("result", result);
    return celestrian::http::json(juce::var(o));
  }
  if (request.method == "POST" && request.path == "/control")
    return celestrian::http::json(control(host, juce::JSON::parse(request.body)));
  if (request.method == "GET") {
    juce::String rel = request.path;
    if (rel.startsWith("/")) rel = rel.substring(1);
    if (rel.isEmpty()) rel = "index.html";
    if (rel.contains("..")) return celestrian::http::statusOnly(404);
    const juce::File file = ui_dir.getChildFile(rel);
    celestrian::http::Response response{200, celestrian::bridge::mimeFor(file), {}};
    if (!file.existsAsFile() || !file.loadFileAsData(response.body))
      return celestrian::http::statusOnly(404);
    return response;
  }
  return celestrian::http::statusOnly(400);
}

Options parseArgs(const juce::StringArray& args) {
  Options o;
  for (int i = 0; i < args.size(); ++i) {
    const auto& a = args[i];
    auto next = [&]() -> juce::String { return i + 1 < args.size() ? args[++i] : ""; };
    if (a == "--port") o.port = next().getIntValue();
    else if (a == "--ui-dir") o.ui_dir = juce::File::getCurrentWorkingDirectory().getChildFile(next());
    else if (a == "--projects-dir") o.projects_dir = juce::File::getCurrentWorkingDirectory().getChildFile(next());
    else if (a == "--input") o.input = next();
    else if (a == "--freq") o.freq = next().getDoubleValue();
    else if (a == "--gain") o.gain = next().getDoubleValue();
    else if (a == "--block") o.block = next().getIntValue();
    else if (a == "--inputs") o.inputs = next().getIntValue();
    else if (a == "--paused") o.paused = true;
  }
  if (o.ui_dir == juce::File()) {
    const auto cwd = juce::File::getCurrentWorkingDirectory();
    o.ui_dir = cwd.getChildFile("ui").isDirectory() ? cwd.getChildFile("ui") : cwd;
  }
  if (o.projects_dir == juce::File()) {
    o.projects_dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                         .getChildFile("CelestrianHeadless")
                         .getChildFile("projects-" + juce::String(juce::Time::currentTimeMillis()));
  }
  o.projects_dir.createDirectory();
  if (o.block <= 0) o.block = 512;
  return o;
}

/** Every protocol name (ui/js/protocol.js) the server does not bind —
 * a startup self-check, warning only. */
void checkProtocol(const Options& o, Host& host) {
  const juce::File proto = o.ui_dir.getChildFile("js/protocol.js");
  if (!proto.existsAsFile()) return;
  const juce::String src = proto.loadFileAsString();
  juce::StringArray lines;
  lines.addLines(src);
  for (const auto& line : lines) {
    const int at = line.indexOf("name: '");
    if (at < 0) continue;
    const juce::String name = line.substring(at + 7).upToFirstOccurrenceOf("'", false, false);
    if (!host.has(name))
      juce::Logger::writeToLog("headless: WARNING protocol method not bound: " + name);
  }
}

void onSignal(int) { g_quit.store(true); }

}  // namespace

int main(int argc, char* argv[]) {
  juce::StringArray args;
  for (int i = 1; i < argc; ++i) args.add(juce::String::fromUTF8(argv[i]));
  // The plugin scan re-launches this executable as its worker.
  if (celestrian::scan_worker::isWorkerInvocation(args))
    return celestrian::scan_worker::run(args);

  const juce::ScopedJuceInitialiser_GUI juce_runtime;
  StdoutLogger logger;
  juce::Logger::setCurrentLogger(&logger);

  const Options opts = parseArgs(args);
  Host host(opts);
  host.setInput(opts.input, opts.freq, opts.gain);
  Heartbeat heartbeat(host);
  ClockThread clock(host);
  celestrian::http::Server server(opts.port, [&host, &opts](const celestrian::http::Request& request) {
    return route(host, opts.ui_dir, request);
  });
  if (!server.listen()) {
    juce::Logger::writeToLog("headless: cannot listen on port " +
                             juce::String(opts.port));
    return 1;
  }
  checkProtocol(opts, host);
  clock.startThread();
  server.startThread();
  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);

  juce::Logger::writeToLog("headless: engine at http://localhost:" +
                           juce::String(opts.port) + "/index.html?engine=true  (ui " +
                           opts.ui_dir.getFullPathName() + ", projects " +
                           opts.projects_dir.getFullPathName() + ", input " +
                           opts.input + (opts.paused ? ", clock PAUSED" : "") + ")");

  // The message loop, by hand: a console tool has no NSApplication, and
  // on macOS runDispatchLoop() is `[NSApp run]` — which returns at once
  // when NSApp is nil. runDispatchLoopUntil pumps the CFRunLoop (where
  // callAsync and the timers deliver) with no app object needed.
  while (!g_quit.load()) juce::MessageManager::getInstance()->runDispatchLoopUntil(50);

  server.stopListening();
  server.stopThread(2000);
  clock.stopThread(2000);
  juce::Logger::setCurrentLogger(nullptr);
  return 0;
}
