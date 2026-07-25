#include "session_io.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>

#include "clip_node.h"
#include "timing.h"

namespace celestrian::session_io {

namespace {

using timing::QTime;

juce::var qvar(QTime q) {
  auto *o = new juce::DynamicObject();
  o->setProperty("num", (double)q.num);
  o->setProperty("den", (double)q.den);
  return juce::var(o);
}

QTime qread(const juce::var &v) {
  if (auto *o = v.getDynamicObject()) {
    return timing::qtime((int64_t)(double)o->getProperty("num"),
                         (int64_t)(double)o->getProperty("den"));
  }
  return {0, 1};
}

// The fx params only (drops the scope telemetry getMetadata may attach).
juce::var effectsBlob(const AudioNode &node) {
  const auto meta = node.effects().getMetadata();
  auto *out = new juce::DynamicObject();
  for (const char *fx : {"eq", "compressor", "echo", "reverb"})
    out->setProperty(fx, meta.getProperty(fx, juce::var()));
  return juce::var(out);
}

void writeClipWav(const ClipNode &clip, int64_t duration,
                  const juce::File &audioDir, bool incremental) {
  const auto &buf = clip.getAudioBuffer();
  // Content base (Q13 lock-collapse): save the COMMITTED content —
  // [base, base + duration). A collapsed take saves as the perfect
  // window; the cut material is undo-only state, not session state.
  const int64_t base = clip.getContentBase();
  const int n =
      (int)std::min<int64_t>(duration, (int64_t)buf.getNumSamples() - base);
  if (n <= 0) return;
  audioDir.createDirectory();
  auto file = audioDir.getChildFile(clip.getUuid() + ".wav");
  if (incremental && file.existsAsFile()) {
    // Committed audio is immutable; a matching length means current.
    // Duration changes (lock-collapse / uncollapse) mismatch → rewrite.
    juce::WavAudioFormat probe;
    std::unique_ptr<juce::AudioFormatReader> r(
        probe.createReaderFor(file.createInputStream().release(), true));
    if (r && r->lengthInSamples == n) return;
  }
  file.deleteFile();

  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::FileOutputStream> stream(file.createOutputStream());
  if (!stream) return;
  // 32-bit float: lossless round-trip of the recorded buffer.
  std::unique_ptr<juce::AudioFormatWriter> writer(fmt.createWriterFor(
      stream.get(), clip.getSampleRate(), 1, 32, {}, 0));
  if (!writer) return;
  stream.release();  // the writer owns the stream now
  writer->writeFromAudioSampleBuffer(buf, (int)base, n);
}

bool readClipWav(const juce::File &file, juce::AudioBuffer<float> &out) {
  if (!file.existsAsFile()) return false;
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::AudioFormatReader> reader(
      fmt.createReaderFor(file.createInputStream().release(), true));
  if (!reader) return false;
  const int len = (int)reader->lengthInSamples;
  out.setSize(1, len);
  reader->read(&out, 0, len, 0, true, false);
  return true;
}

juce::var serializeNode(const AudioNode &node, int64_t q, int64_t epoch,
                        const juce::File &audioDir, const SaveOptions &opts) {
  auto *o = new juce::DynamicObject();
  o->setProperty("id", node.getUuid());
  o->setProperty("name", node.getName());
  o->setProperty("type", node.getNodeTypeString());
  o->setProperty("muted", (bool)node.is_muted.load());
  o->setProperty("loopBypassed",
                 opts.strip_performances ? false : node.isLoopWindowBypassed());
  // Window segments are musical (QTime): stored device-independently.
  // Templates strip them (a window is a fact about a performance).
  const int64_t ws = opts.strip_performances ? 0 : node.getLoopStart();
  const int64_t we = opts.strip_performances ? 0 : node.getLoopEnd();
  o->setProperty("windowStartQ", qvar(timing::fromSamples(ws, q)));
  o->setProperty("windowEndQ", qvar(timing::fromSamples(we, q)));
  // Multi-segment map (phase 3): a list of {startQ, endQ} pairs,
  // additive to the format (absent = single-window fallback). Stripped
  // with the window — a map is a fact about a performance.
  if (!opts.strip_performances) {
    if (const auto *m = node.mapOverride()) {
      juce::Array<juce::var> segs;
      for (int i = 0; i < m->n; ++i) {
        auto *so = new juce::DynamicObject();
        so->setProperty("startQ", qvar(timing::fromSamples(m->segs[i].start, q)));
        so->setProperty("endQ", qvar(timing::fromSamples(m->segs[i].end, q)));
        segs.add(juce::var(so));
      }
      o->setProperty("segmentsQ", segs);
    }
  }
  o->setProperty("effects", effectsBlob(node));

  if (node.getNodeType() == NodeType::Clip) {
    const auto &clip = static_cast<const ClipNode &>(node);
    const int64_t origin = node.origin_samples.load();
    const int64_t duration = node.duration_samples.load();
    o->setProperty("inputChannel", clip.getInputChannel());
    // origin as an OFFSET FROM EPOCH, period, contextCycle — all musical.
    // Templates strip performances: the clip persists as a named, wired,
    // EMPTY track (docs/projects.md).
    const int64_t sOrigin = opts.strip_performances ? 0 : origin;
    const int64_t sDur = opts.strip_performances ? 0 : duration;
    o->setProperty("originQ", qvar(timing::originQ(sOrigin, epoch, q)));
    o->setProperty("periodQ", qvar(timing::periodQ(sDur, q)));
    o->setProperty("contextCycleQ",
                   qvar(timing::fromSamples(
                       opts.strip_performances ? 0 : clip.contextCycle(), q)));
    const bool hasAudio = sDur > 0;
    o->setProperty("hasAudio", hasAudio);
    if (hasAudio) writeClipWav(clip, duration, audioDir, opts.incremental);
  } else {
    const auto &stack = static_cast<const StackNode &>(node);
    o->setProperty("x", node.x_pos.load());
    o->setProperty("y", node.y_pos.load());
    juce::Array<juce::var> kids;
    for (const auto &child : stack.ownedChildren())
      kids.add(serializeNode(*child, q, epoch, audioDir, opts));
    o->setProperty("nodes", kids);
  }
  return juce::var(o);
}

std::unique_ptr<AudioNode> deserializeNode(const juce::var &v, int64_t q,
                                           int64_t epoch, double sr,
                                           const juce::File &audioDir) {
  auto *o = v.getDynamicObject();
  if (!o) return nullptr;
  const juce::String type = o->getProperty("type").toString();
  const juce::String uuid = o->getProperty("id").toString();
  const juce::String name = o->getProperty("name").toString();

  std::unique_ptr<AudioNode> node;
  if (type == "stack") {
    auto stack = std::make_unique<StackNode>(name);
    stack->x_pos.store((double)o->getProperty("x"));
    stack->y_pos.store((double)o->getProperty("y"));
    if (auto *kids = o->getProperty("nodes").getArray()) {
      for (const auto &c : *kids)
        if (auto ch = deserializeNode(c, q, epoch, sr, audioDir))
          stack->addChild(std::move(ch));
    }
    // Only the island ROOT owns (Q, epoch); clear any quantum that
    // addChild transiently established on this detached subtree — the
    // engine forces the island values on the real root after attaching.
    stack->setQuantum(0, 0);
    node = std::move(stack);
  } else {
    auto clip = std::make_unique<ClipNode>(name, sr);
    const int64_t origin = epoch + timing::toSamples(qread(o->getProperty("originQ")), q);
    const int64_t duration = timing::toSamples(qread(o->getProperty("periodQ")), q);
    const int64_t ctx = timing::toSamples(qread(o->getProperty("contextCycleQ")), q);
    clip->setInputChannel((int)o->getProperty("inputChannel"));
    clip->origin_samples.store(origin);
    clip->duration_samples.store(duration);
    if ((bool)o->getProperty("hasAudio")) {
      juce::AudioBuffer<float> audio;
      if (readClipWav(audioDir.getChildFile(uuid + ".wav"), audio))
        clip->loadCommitted(audio, ctx);
    }
    node = std::move(clip);
  }

  node->setUuid(uuid);
  node->is_muted.store((bool)o->getProperty("muted"));
  node->setLoopPoints(timing::toSamples(qread(o->getProperty("windowStartQ")), q),
                      timing::toSamples(qread(o->getProperty("windowEndQ")), q));
  // Multi-segment map (phase 3): ≥2 entries install an override
  // (pre-graph node: no old pointer, no retire needed); absent/short
  // lists keep the single-window fallback above.
  if (auto *segs = o->getProperty("segmentsQ").getArray();
      segs != nullptr && segs->size() >= 2) {
    timing::TimeMap m;
    for (const auto &sv : *segs) {
      if (m.n >= timing::TimeMap::kMaxSegments) break;
      m.segs[m.n++] = {
          timing::toSamples(qread(sv.getProperty("startQ", {})), q),
          timing::toSamples(qread(sv.getProperty("endQ", {})), q)};
    }
    delete node->exchangeMapOverride(new timing::TimeMap(m));
  }
  node->setLoopWindowBypassed((bool)o->getProperty("loopBypassed"));
  applyEffects(*node, o->getProperty("effects"), sr);
  return node;
}

}  // namespace

// getMetadata()'s param keys match setParam()'s keys exactly, so restore
// is generic: for each fx, replay enabled + every numeric field.
BundleInfo readBundleInfo(const juce::File &dir) {
  BundleInfo out;
  const auto jf = dir.getChildFile("session.json");
  if (!jf.existsAsFile()) return out;
  const auto root = juce::JSON::parse(jf.loadFileAsString());
  auto *o = root.getDynamicObject();
  if (!o) return out;
  out.ok = true;
  out.name = o->getProperty("name").toString();
  out.created = o->getProperty("created").toString();
  return out;
}

void applyEffects(AudioNode &node, const juce::var &blob, double sr) {
  if (!blob.isObject()) return;
  node.effects().prepare(sr);
  for (const char *fx : {"eq", "compressor", "echo", "reverb"}) {
    const auto sub = blob.getProperty(fx, juce::var());
    if (auto *o = sub.getDynamicObject()) {
      for (const auto &p : o->getProperties()) {
        const juce::String key = p.name.toString();
        if (key == "enabled")
          node.effects().setEnabled(fx, (bool)p.value);
        else
          node.effects().setParam(fx, key, (double)p.value);
      }
    }
  }
}

bool save(const StackNode &root, double device_sample_rate,
          const juce::File &dir, const SaveOptions &opts) {
  dir.createDirectory();
  const auto audioDir = dir.getChildFile("audio");
  audioDir.createDirectory();

  // Templates are pre-Q by construction (no performances → no grid).
  const int64_t q = opts.strip_performances ? 0 : root.getQuantum();
  const int64_t epoch = opts.strip_performances ? 0 : root.getEpoch();

  auto *top = new juce::DynamicObject();
  top->setProperty("version", 1);
  if (opts.display_name.isNotEmpty())
    top->setProperty("name", opts.display_name);
  if (opts.created.isNotEmpty()) top->setProperty("created", opts.created);
  top->setProperty("sampleRate", device_sample_rate);
  top->setProperty("qSamples", (double)q);
  top->setProperty("epoch", (double)epoch);
  top->setProperty("rootMuted", (bool)root.is_muted.load());
  top->setProperty("rootEffects", effectsBlob(root));

  juce::Array<juce::var> nodes;
  for (const auto &child : root.ownedChildren())
    nodes.add(serializeNode(*child, q, epoch, audioDir, opts));
  top->setProperty("nodes", nodes);

  const auto json = juce::JSON::toString(juce::var(top), true);
  return dir.getChildFile("session.json").replaceWithText(json);
}

LoadedSession load(const juce::File &dir, double device_sample_rate) {
  LoadedSession out;
  const auto jf = dir.getChildFile("session.json");
  if (!jf.existsAsFile()) return out;

  const auto root = juce::JSON::parse(jf.loadFileAsString());
  auto *o = root.getDynamicObject();
  if (!o) return out;

  out.q_samples = (int64_t)(double)o->getProperty("qSamples");
  out.epoch = (int64_t)(double)o->getProperty("epoch");
  out.sample_rate = o->hasProperty("sampleRate")
                        ? (double)o->getProperty("sampleRate")
                        : device_sample_rate;
  out.root_muted = (bool)o->getProperty("rootMuted");
  out.root_effects = o->getProperty("rootEffects");
  out.display_name = o->getProperty("name").toString();
  out.created = o->getProperty("created").toString();

  const auto audioDir = dir.getChildFile("audio");
  if (auto *nodes = o->getProperty("nodes").getArray()) {
    for (const auto &n : *nodes)
      if (auto ch = deserializeNode(n, out.q_samples, out.epoch,
                                    out.sample_rate, audioDir))
        out.children.push_back(std::move(ch));
  }
  out.ok = true;
  return out;
}

}  // namespace celestrian::session_io
