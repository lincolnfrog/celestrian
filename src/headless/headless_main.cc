/**
 * THE HEADLESS ENGINE SERVER — the real engine, no window, no device
 * (docs/test_harness.md "Engine e2e").
 *
 * What it is: AudioEngine + ProjectManager + PluginHostService driven
 * by a SYNTHETIC audio clock (a thread pacing device-sized blocks of a
 * generated input — sine, ramp or silence — through the one callback
 * the real device would call), with the WebView bridge table
 * (src/bridge_dispatch.cc — the same entries the app registers) served
 * over HTTP, and ui/ served as static files from the same origin. Load
 * `http://localhost:PORT/index.html?engine=true` in any browser and the
 * REAL UI runs against the REAL engine; Playwright does exactly that
 * (ui/playwright.engine.config.js, specs in ui/e2e_engine).
 *
 * Why: the mock has no audio and the WebView cannot be driven headless,
 * so "what I see is not what I hear" bugs had no test layer. This is
 * that layer. The `/control` surface makes it deterministic: pause the
 * clock, advance it by exact sample counts, choose the input, and ask
 * for the AUDIBLE TRUTH — which clips actually sound in which Q cell
 * (the engine solos each one and listens).
 *
 *   POST /call     {name, args[]}   → {result}        (the bridge table)
 *   POST /control  {op, ...}        → op-specific JSON (below)
 *   GET  /<path>                    → ui/<path>       (index.html default)
 *
 * Control ops: status · pause · resume · advance{samples} · input{kind,
 * freq, gain} · truth · reset · quit.
 *
 * Threads, exactly as in the app: bridge handlers run on the MESSAGE
 * thread (the HTTP thread marshals each call there and waits); the
 * clock thread is THE audio thread; `advance` and `truth` run blocks
 * from the HTTP thread while the clock thread is paused (one mutex
 * serialises every callback).
 *
 *   CelestrianHeadless [--port 8091] [--ui-dir DIR] [--projects-dir DIR]
 *                      [--input sine|ramp|silence] [--freq 220]
 *                      [--block 512] [--paused]
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
#include "../period_law.h"
#include "../plugin_host_service.h"
#include "../plugin_scan_worker.h"
#include "../project_manager.h"

namespace {

struct Options {
  int port = 8091;
  juce::File ui_dir;
  juce::File projects_dir;
  juce::String input = "sine";
  double freq = 220.0;
  double gain = 0.5;
  int block = 512;
  bool paused = false;
};

class StdoutLogger : public juce::Logger {
  void logMessage(const juce::String& m) override {
    std::cout << m << std::endl;
  }
};

inline int64_t posmod(int64_t a, int64_t m) { return m > 0 ? ((a % m) + m) % m : 0; }

std::atomic<bool> g_quit{false};

/** Run `fn` on the message thread and wait for it (the HTTP thread's
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
    for (auto& m : celestrian::bridge::engineMethods(
             {engine_, projects_, plugins_})) {
      handlers_[m.name] = m.handler;
    }
    // Window-bound verbs, stood in: no chooser, no editor, no pointer.
    auto refuse = [](juce::var v) {
      return [v](const juce::Array<juce::var>&, celestrian::bridge::Completion done) {
        done(v);
      };
    };
    handlers_["bounceWithDialog"] = refuse(false);
    handlers_["importAudioWithDialog"] = refuse(false);
    handlers_["chooseProjectsRoot"] = refuse(juce::String());
    handlers_["warpPointer"] = refuse(false);
    handlers_["openPluginEditor"] = refuse(true);
    paused_.store(o.paused);
    in_.resize((size_t)o.block);
    out_l_.resize((size_t)o.block);
    out_r_.resize((size_t)o.block);
  }

  AudioEngine& engine() { return engine_; }
  celestrian::ProjectManager& projects() { return projects_; }
  const Options& opts() const { return opts_; }
  bool paused() const { return paused_.load(); }
  void setPaused(bool p) { paused_.store(p); }
  double rate() const { return rate_; }

  bool has(const juce::String& name) const { return handlers_.count(name) > 0; }

  /** The bridge call, marshalled to the message thread. */
  juce::var call(const juce::String& name, const juce::Array<juce::var>& args,
                 bool& found) {
    auto it = handlers_.find(name);
    found = it != handlers_.end();
    if (!found) return {};
    juce::var result;
    onMessageThread([&] {
      it->second(args, [&](juce::var r) { result = r; });
    });
    return result;
  }

  /** Render `total` samples through the device callback (the audio
   * thread's job; serialised with the clock thread). Appends channel 0
   * to `capture` when given. */
  void render(int64_t total, std::vector<float>* capture = nullptr) {
    std::lock_guard<std::mutex> lock(callback_mutex_);
    const int block = opts_.block;
    const float* ins[] = {in_.data()};
    float* outs[] = {out_l_.data(), out_r_.data()};
    int64_t remaining = total;
    while (remaining > 0) {
      const int n = (int)std::min<int64_t>(remaining, block);
      fillInput(n);
      engine_.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
      if (capture != nullptr)
        capture->insert(capture->end(), out_l_.begin(), out_l_.begin() + n);
      input_clock_ += n;
      remaining -= n;
    }
  }

  void setInput(const juce::String& kind, double freq, double gain) {
    std::lock_guard<std::mutex> lock(callback_mutex_);
    input_kind_ = kind;
    if (freq > 0) freq_ = freq;
    if (gain >= 0) gain_ = gain;
  }

  int64_t inputClock() const { return input_clock_; }

  /** Facts the specs steer by (message thread). `islandPos` is the raw
   * clock epoch-relative and unwrapped (the engine's contract), so the
   * island phase is `islandPos mod cycle`. */
  juce::var status() {
    auto* o = new juce::DynamicObject();
    onMessageThread([&] {
      const juce::var st = engine_.getGraphState();
      const int64_t q = (int64_t)(double)st.getProperty("quantum", 0);
      o->setProperty("quantum", (double)q);
      o->setProperty("epoch", (double)(int64_t)(double)st.getProperty("islandEpoch", 0));
      o->setProperty("islandPos", (double)(int64_t)(double)st.getProperty("islandPos", 0));
      o->setProperty("masterPos", (double)(int64_t)(double)st.getProperty("masterPos", 0));
      o->setProperty("cycle", (double)islandCycle(st));
      o->setProperty("isPlaying", (bool)st.getProperty("isPlaying", false));
      o->setProperty("rootId", st.getProperty("id", ""));
    });
    o->setProperty("paused", paused_.load());
    o->setProperty("clock", (double)input_clock_);
    o->setProperty("rate", rate_);
    o->setProperty("block", opts_.block);
    o->setProperty("input", input_kind_);
    return juce::var(o);
  }

  /** THE AUDIBLE TRUTH: for every clip, which Q cells of the island
   * cycle it sounds in — the engine solos it and listens to one cycle.
   * Cells are in the EPOCH frame (the ruler). Runs with the clock
   * paused; the transport advances by (clips × (cycle + block)). */
  juce::var truth() {
    const bool was_paused = paused_.exchange(true);
    juce::var st;
    onMessageThread([&] {
      if (!engine_.isPlaying()) engine_.togglePlayback();
      st = engine_.getGraphState();
    });
    const int64_t q = (int64_t)(double)st.getProperty("quantum", 0);
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
        juce::Array<juce::var> dummy;
        dummy.add(id);
        bool found = false;
        call("toggleSolo", dummy, found);
        // The published islandPos is the raw clock EPOCH-RELATIVE and
        // unwrapped (AudioEngine::getGraphState) — the phase of the
        // first rendered sample is simply its fold on the cycle.
        int64_t pos0 = 0;
        onMessageThread([&] {
          pos0 = (int64_t)(double)engine_.getGraphState().getProperty("islandPos", 0);
        });
        std::vector<float> out;
        render(cycle + opts_.block, &out);
        juce::Array<juce::var> row;
        for (int c = 0; c < cells; ++c) {
          // The cell's centre in the epoch frame, ±128 samples: the
          // clip's own signal or exact silence (gates are 10 ms ramps,
          // far from a cell centre).
          const int64_t want = c * q + q / 2;
          float peak = 0.0f;
          for (int64_t k = 0; k < (int64_t)out.size(); ++k) {
            const int64_t ph = posmod(pos0 + k, cycle);
            if (std::llabs(ph - want) <= 128) peak = std::max(peak, std::abs(out[(size_t)k]));
          }
          row.add(peak > 1.0e-6f);
        }
        rows->setProperty(id, row);
        call("toggleSolo", dummy, found);
      }
    } else {
      doc->setProperty("cycleQ", 0);
    }
    doc->setProperty("truth", juce::var(rows));
    paused_.store(was_paused);
    return juce::var(doc);
  }

  /** Back to an empty project: every top-level node deleted, the root
   * song cleared, the history dropped. */
  void reset() {
    onMessageThread([&] {
      const juce::var st = engine_.getGraphState();
      const juce::String root = st.getProperty("id", "").toString();
      if (auto* nodes = st.getProperty("nodes", juce::var()).getArray()) {
        for (const auto& n : *nodes)
          engine_.deleteNode(n.getProperty("id", "").toString());
      }
      engine_.setSequence(root, juce::var());
      if (!engine_.isPlaying()) engine_.togglePlayback();
      engine_.tick();
    });
  }

 private:
  void fillInput(int n) {
    for (int i = 0; i < n; ++i) {
      const int64_t t = input_clock_ + i;
      float v = 0.0f;
      if (input_kind_ == "sine") {
        v = (float)(gain_ * std::sin(2.0 * juce::MathConstants<double>::pi *
                                     freq_ * (double)t / rate_));
      } else if (input_kind_ == "ramp") {
        // The scenario harness's sawtooth (tests/scenario_utils.h):
        // every sample encodes its own clock.
        const int64_t P = int64_t{1} << 20;
        v = 0.5f * (float)((double)posmod(t, P) / (double)P);
      }
      in_[(size_t)i] = v;
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
   * (message thread). */
  int64_t islandCycle(const juce::var& st) {
    auto* root = engine_.findNodeByUuidForTest(st.getProperty("id", "").toString());
    if (root == nullptr) return 0;
    const int64_t q = (int64_t)(double)st.getProperty("quantum", 0);
    return celestrian::period_law::islandCycle(celestrian::period_law::TreeProvider{},
                                               root, q, (int64_t)rate_);
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
  std::mutex callback_mutex_;
  std::vector<float> in_, out_l_, out_r_;
  int64_t input_clock_ = 0;
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
// A minimal HTTP/1.1 server (one connection at a time, Connection: close).
// ---------------------------------------------------------------------------
class HttpThread : public juce::Thread {
 public:
  HttpThread(Host& h, const Options& o)
      : juce::Thread("engine http"), host_(h), opts_(o) {}

  bool listen() {
    if (!listener_.createListener(opts_.port, "127.0.0.1")) {
      juce::Logger::writeToLog("headless: cannot listen on port " +
                               juce::String(opts_.port));
      return false;
    }
    return true;
  }

  void run() override {
    while (!threadShouldExit()) {
      std::unique_ptr<juce::StreamingSocket> conn(listener_.waitForNextConnection());
      if (conn == nullptr) continue;
      handle(*conn);
      conn->close();
    }
  }

  void stopListening() { listener_.close(); }

 private:
  struct Request {
    juce::String method, path;
    std::map<juce::String, juce::String> headers;
    juce::String body;
  };

  bool readRequest(juce::StreamingSocket& s, Request& req) {
    std::vector<char> data;
    size_t header_end = std::string::npos;
    int64_t content_length = 0;
    char buf[8192];
    while (true) {
      if (header_end != std::string::npos &&
          (int64_t)(data.size() - header_end - 4) >= content_length)
        break;
      const int ready = s.waitUntilReady(true, 5000);
      if (ready <= 0) return false;
      const int n = s.read(buf, (int)sizeof(buf), false);
      if (n <= 0) return false;
      data.insert(data.end(), buf, buf + n);
      if (header_end == std::string::npos) {
        const std::string sv(data.data(), data.size());
        header_end = sv.find("\r\n\r\n");
        if (header_end != std::string::npos) {
          const juce::String head(sv.substr(0, header_end));
          juce::StringArray lines;
          lines.addLines(head);
          if (lines.isEmpty()) return false;
          juce::StringArray parts;
          parts.addTokens(lines[0], " ", "");
          if (parts.size() < 2) return false;
          req.method = parts[0];
          req.path = parts[1].upToFirstOccurrenceOf("?", false, false);
          for (int i = 1; i < lines.size(); ++i) {
            const juce::String k = lines[i].upToFirstOccurrenceOf(":", false, false)
                                       .trim().toLowerCase();
            const juce::String v = lines[i].fromFirstOccurrenceOf(":", false, false).trim();
            req.headers[k] = v;
          }
          content_length = req.headers.count("content-length")
                               ? req.headers["content-length"].getLargeIntValue()
                               : 0;
        }
      }
    }
    req.body = juce::String::fromUTF8(data.data() + header_end + 4,
                                      (int)content_length);
    return true;
  }

  void respond(juce::StreamingSocket& s, int status, const juce::String& mime,
               const juce::MemoryBlock& body) {
    const char* text = status == 200 ? "OK" : status == 204 ? "No Content"
                       : status == 404 ? "Not Found" : "Bad Request";
    juce::String head;
    head << "HTTP/1.1 " << status << " " << text << "\r\n"
         << "Content-Type: " << mime << "\r\n"
         << "Content-Length: " << (int64_t)body.getSize() << "\r\n"
         << "Cache-Control: no-store\r\n"
         << "Access-Control-Allow-Origin: *\r\n"
         << "Access-Control-Allow-Headers: Content-Type\r\n"
         << "Connection: close\r\n\r\n";
    const auto h = head.toStdString();
    s.write(h.data(), (int)h.size());
    if (body.getSize() > 0) s.write(body.getData(), (int)body.getSize());
  }

  void respondJson(juce::StreamingSocket& s, const juce::var& v) {
    const auto text = juce::JSON::toString(v, true).toStdString();
    respond(s, 200, "application/json", juce::MemoryBlock(text.data(), text.size()));
  }

  static juce::String mimeFor(const juce::File& f) {
    const auto ext = f.getFileExtension().toLowerCase();
    if (ext == ".html") return "text/html";
    if (ext == ".css") return "text/css";
    if (ext == ".js" || ext == ".mjs") return "application/javascript";
    if (ext == ".png") return "image/png";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".ico") return "image/x-icon";
    if (ext == ".json") return "application/json";
    if (ext == ".wav") return "audio/wav";
    return "text/plain";
  }

  void handle(juce::StreamingSocket& s) {
    Request req;
    if (!readRequest(s, req)) return;
    if (req.method == "OPTIONS") {
      respond(s, 204, "text/plain", {});
      return;
    }
    if (req.method == "POST" && req.path == "/call") {
      const juce::var body = juce::JSON::parse(req.body);
      const juce::String name = body.getProperty("name", "").toString();
      juce::Array<juce::var> args;
      if (auto* a = body.getProperty("args", juce::var()).getArray()) args = *a;
      bool found = false;
      const juce::var result = host_.call(name, args, found);
      if (!found) {
        juce::Logger::writeToLog("headless: unknown bridge method " + name);
        respond(s, 404, "text/plain", {});
        return;
      }
      auto* o = new juce::DynamicObject();
      o->setProperty("result", result);
      respondJson(s, juce::var(o));
      return;
    }
    if (req.method == "POST" && req.path == "/control") {
      respondJson(s, control(juce::JSON::parse(req.body)));
      return;
    }
    if (req.method == "GET") {
      juce::String rel = req.path;
      if (rel.startsWith("/")) rel = rel.substring(1);
      if (rel.isEmpty()) rel = "index.html";
      if (rel.contains("..")) {
        respond(s, 404, "text/plain", {});
        return;
      }
      const juce::File f = opts_.ui_dir.getChildFile(rel);
      juce::MemoryBlock mb;
      if (!f.existsAsFile() || !f.loadFileAsData(mb)) {
        respond(s, 404, "text/plain", {});
        return;
      }
      respond(s, 200, mimeFor(f), mb);
      return;
    }
    respond(s, 400, "text/plain", {});
  }

  juce::var control(const juce::var& body) {
    const juce::String op = body.getProperty("op", "").toString();
    auto ok = [](bool v = true) {
      auto* o = new juce::DynamicObject();
      o->setProperty("ok", v);
      return juce::var(o);
    };
    if (op == "status") return host_.status();
    if (op == "pause") {
      host_.setPaused(true);
      return ok();
    }
    if (op == "resume") {
      host_.setPaused(false);
      return ok();
    }
    if (op == "advance") {
      const int64_t n = (int64_t)(double)body.getProperty("samples", 0);
      if (n > 0) host_.render(n);
      auto* o = new juce::DynamicObject();
      o->setProperty("ok", true);
      o->setProperty("clock", (double)host_.inputClock());
      return juce::var(o);
    }
    if (op == "input") {
      host_.setInput(body.getProperty("kind", "sine").toString(),
                     (double)body.getProperty("freq", 0.0),
                     body.hasProperty("gain") ? (double)body.getProperty("gain", 0.5) : -1.0);
      return ok();
    }
    if (op == "truth") return host_.truth();
    if (op == "reset") {
      host_.reset();
      return ok();
    }
    if (op == "quit") {
      g_quit.store(true);
      return ok();
    }
    juce::Logger::writeToLog("headless: unknown control op " + op);
    return ok(false);
  }

  Host& host_;
  Options opts_;
  juce::StreamingSocket listener_;
};

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
  HttpThread http(host, opts);
  if (!http.listen()) return 1;
  checkProtocol(opts, host);
  clock.startThread();
  http.startThread();
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

  http.stopListening();
  http.stopThread(2000);
  clock.stopThread(2000);
  juce::Logger::setCurrentLogger(nullptr);
  return 0;
}
