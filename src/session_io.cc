// session_io — the session bundle format: a directory holding
// session.json plus audio/*.wav (one file per committed audio take).
// The format is device-independent: musical positions (origins, loop
// points, maps) are stored as QTime and rendered back at the load-time
// sample rate. This file owns serializeNode / deserializeNode (the node
// tree: takes, windows, maps, sequences, fx chains, MIDI content),
// readBundleInfo (the project picker's summary), applyEffects (rack
// restore from the metadata blob) and save / load (the bundle level:
// root rack, island (Q, epoch), sample rate). Message thread only.

#include "session_io.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>

#include "clip_node.h"
#include "dsp/vst3_slot.h"
#include "timing.h"

namespace celestrian::session_io {

namespace {

using timing::QTime;

// Forwarded to the ONE QTime serializer (AudioNode::qtimeVar) so the
// save format and the metadata path can never drift apart.
juce::var qvar(QTime q) { return AudioNode::qtimeVar(q); }

QTime qread(const juce::var& v) {
  if (auto* o = v.getDynamicObject()) {
    return timing::qtime((int64_t)(double)o->getProperty("num"),
                         (int64_t)(double)o->getProperty("den"));
  }
  return {0, 1};
}

// The chain array verbatim (docs/vst3.md §6): the chain's metadata IS
// the save format — [{slot, type, enabled, ...params}] in signal order.
// (Scope telemetry lives outside the chain and never appears here.)
// A stack's SEQUENCE block (docs/sequencer.md): steps as QTime lengths
// with cue + successors, the seed, gates keyed by child uuid, the
// bypass flag. Void when the stack has none. ONE writer for nested
// stacks and the root (the root's block is bundle-level).
juce::var sequenceVar(const StackNode& stack, int64_t q) {
  const Sequence* s = stack.sequencePtr();
  if (s == nullptr) return juce::var();
  auto* so = new juce::DynamicObject();
  so->setProperty("bypassed", stack.isSequenceBypassed());
  juce::Array<juce::var> steps;
  for (const auto& st : s->steps) {
    auto* stepo = new juce::DynamicObject();
    stepo->setProperty("name", st.name);
    stepo->setProperty("lenQ", qvar(timing::fromSamples(st.len, q)));
    if (st.cue) stepo->setProperty("cue", true);  // additive
    if (!st.next.empty())
      stepo->setProperty("next", Sequence::successorsVar(st));  // additive
    // Per-step fades (S13): musical lengths, QTime like lenQ. Additive.
    if (st.fade_in > 0)
      stepo->setProperty("fadeInQ", qvar(timing::fromSamples(st.fade_in, q)));
    if (st.fade_out > 0)
      stepo->setProperty("fadeOutQ", qvar(timing::fromSamples(st.fade_out, q)));
    steps.add(juce::var(stepo));
  }
  so->setProperty("steps", steps);
  if (s->seed != 0) so->setProperty("seed", (double)s->seed);  // additive
  auto* gateso = new juce::DynamicObject();
  for (const auto& row : s->gates) {
    juce::Array<juce::var> bits;
    for (int i = 0; i < s->numSteps(); ++i) bits.add(s->on(row.mask, i));
    gateso->setProperty(row.uuid, bits);
  }
  so->setProperty("gates", juce::var(gateso));
  return juce::var(so);
}

juce::var effectsBlob(const AudioNode& node) {
  return node.fxChain()->getMetadata(/*include_persistent_state=*/true);
}

/** One take's WAV: the COMMITTED content [base, base + duration) of
 * `buf` (Q13 lock-collapse: a collapsed take saves as the perfect
 * window; the cut material is undo-only state, not session state). */
void writeTakeWav(const juce::AudioBuffer<float>& buf, int64_t base,
                  int64_t duration, double sample_rate, const juce::File& file,
                  bool incremental) {
  const int n =
      (int)std::min<int64_t>(duration, (int64_t)buf.getNumSamples() - base);
  if (n <= 0) return;
  file.getParentDirectory().createDirectory();
  // Committed audio is immutable: an existing file is current unless
  // the clip says otherwise (ClipNode::takeFilesDirty — the ONE truth,
  // set by every message-thread content-frame mutation: collapse,
  // uncollapse, splice, strip/restore, take-list changes, a settled
  // commit). A length probe cannot tell a collapse to [Q, 2Q) from one
  // to [0, Q).
  if (incremental && file.existsAsFile()) return;
  // WRITE-THEN-SWAP (docs/projects.md: at most the take in flight is
  // ever at risk): the new WAV is written beside the target and moved
  // over it only once complete, so a crash or a full disk mid-write
  // leaves the COMMITTED take's file intact.
  juce::TemporaryFile temp(file);
  {
    juce::WavAudioFormat fmt;
    std::unique_ptr<juce::FileOutputStream> stream(
        temp.getFile().createOutputStream());
    if (!stream) return;
    // 32-bit float: lossless round-trip of the recorded buffer. Channel
    // count follows the content (stereo takes save as stereo WAVs).
    std::unique_ptr<juce::AudioFormatWriter> writer(fmt.createWriterFor(
        stream.get(), sample_rate,
        (unsigned int)std::max(1, buf.getNumChannels()), 32, {}, 0));
    if (!writer) return;
    stream.release();  // the writer owns the stream now
    if (!writer->writeFromAudioSampleBuffer(buf, (int)base, n)) return;
    // The writer flushes and closes on destruction (end of scope).
  }
  temp.overwriteTargetFileWithTemporary();
}

/** Take k's file (docs/takes.md): take 0 keeps `<uuid>.wav`, later
 * takes are `<uuid>.take<k>.wav`. */
juce::File takeFile(const juce::File& audioDir, const juce::String& uuid,
                    int k) {
  return audioDir.getChildFile(
      k == 0 ? uuid + ".wav" : uuid + ".take" + juce::String(k) + ".wav");
}

/** Every take of the clip. The incremental probe judges by length,
 * which every take of a slot shares — so a renumbered list (a delete)
 * rewrites all of them (takeFilesDirty) and files past the count go. */
void writeClipWavs(const ClipNode& clip, int64_t duration,
                   const juce::File& audioDir, bool incremental) {
  const int64_t base = clip.getContentBase();
  const int count = clip.takeCount();
  const bool force = clip.takeFilesDirty();
  for (int k = 0; k < count; ++k) {
    const juce::AudioBuffer<float>* buf = clip.takeBuffer(k);
    if (buf == nullptr) continue;
    writeTakeWav(*buf, base, duration, clip.getSampleRate(),
                 takeFile(audioDir, clip.getUuid(), k), incremental && !force);
  }
  for (int k = std::max(1, count); k < ClipNode::kMaxTakes; ++k) {
    const juce::File stale = takeFile(audioDir, clip.getUuid(), k);
    if (stale.existsAsFile()) stale.deleteFile();
  }
  clip.markTakeFilesWritten();
}

/** A MIDI take's events as [[num, den, byte...], ...] — positions as
 * QTime on the island exchange rate, base-relative, inside the
 * committed span. */
juce::var midiEventsVar(const MidiSequence& seq, int64_t base,
                        int64_t duration, int64_t q) {
  juce::Array<juce::var> events;
  for (const MidiEvent& e : seq.snapshot()) {
    const int64_t rel = e.pos - base;
    if (rel < 0 || rel >= duration) continue;
    const timing::QTime pos = timing::fromSamples(rel, q);
    juce::Array<juce::var> ev;
    ev.add((double)pos.num);
    ev.add((double)pos.den);
    for (int k = 0; k < (int)e.size; ++k) ev.add((int)e.bytes[k]);
    events.add(ev);
  }
  return events;
}

/** The inverse of midiEventsVar: content positions in samples. */
std::vector<MidiEvent> parseMidiEvents(const juce::var& v, int64_t q) {
  std::vector<MidiEvent> events;
  if (auto* arr = v.getArray()) {
    events.reserve((size_t)arr->size());
    for (const auto& ev : *arr) {
      auto* fields = ev.getArray();
      if (!fields || fields->size() < 3) continue;
      MidiEvent e;
      e.pos = timing::toSamples(timing::qtime((int64_t)(double)(*fields)[0],
                                              (int64_t)(double)(*fields)[1]),
                                q);
      const int size = std::min(3, fields->size() - 2);
      e.size = (juce::uint8)size;
      for (int k = 0; k < size; ++k)
        e.bytes[k] = (juce::uint8)(int)(*fields)[k + 2];
      events.push_back(e);
    }
  }
  return events;
}

bool readClipWav(const juce::File& file, juce::AudioBuffer<float>& out) {
  if (!file.existsAsFile()) return false;
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::AudioFormatReader> reader(
      fmt.createReaderFor(file.createInputStream().release(), true));
  if (!reader) return false;
  const int len = (int)reader->lengthInSamples;
  const int chans = std::max(1, (int)reader->numChannels);
  out.setSize(chans, len);
  reader->read(&out, 0, len, 0, /*useReaderLeftChan=*/true,
               /*useReaderRightChan=*/chans >= 2);
  return true;
}

juce::var serializeNode(const AudioNode& node, int64_t q, int64_t epoch,
                        const juce::File& audioDir, const SaveOptions& opts) {
  auto* o = new juce::DynamicObject();
  o->setProperty("id", node.getUuid());
  o->setProperty("name", node.getName());
  o->setProperty("type", node.getNodeTypeString());
  o->setProperty("muted", (bool)node.is_muted.load());
  o->setProperty("pan", (double)node.pan.load());
  o->setProperty("gain", (double)node.gain.load());
  // The Q5 period-source knob — additive: absent key = "own" (a loop).
  if (node.period_from_context_.load())
    o->setProperty("periodSource", "context");
  o->setProperty("loopBypassed",
                 opts.strip_performances ? false : node.isLoopWindowBypassed());
  // S16 window domain (docs/sequencer.md §11.8) — additive; absent =
  // intrinsic. Stacks only; stripped with the window on templates.
  if (!opts.strip_performances && node.getNodeType() == NodeType::Stack) {
    const auto& stack = static_cast<const StackNode&>(node);
    if (stack.windowDomain() == StackNode::WindowDomain::Sequence)
      o->setProperty("windowDomain", "sequence");
  }
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
    if (const timing::TimeMap m = node.storedMap(); m.n >= 2) {
      juce::Array<juce::var> segs;
      for (int i = 0; i < m.n; ++i) {
        auto* so = new juce::DynamicObject();
        so->setProperty("startQ",
                        qvar(timing::fromSamples(m.segs[i].start, q)));
        so->setProperty("endQ", qvar(timing::fromSamples(m.segs[i].end, q)));
        segs.add(juce::var(so));
      }
      o->setProperty("segmentsQ", segs);
    }
  }
  o->setProperty("effects", effectsBlob(node));

  if (node.getNodeType() == NodeType::Clip) {
    const auto& clip = static_cast<const ClipNode&>(node);
    const int64_t origin = node.origin_samples.load();
    const int64_t duration = node.duration_samples.load();
    o->setProperty("inputChannel", clip.getInputChannel());
    o->setProperty("inputChannelR", clip.getInputChannelRight());
    // Software input monitoring (Q20) — additive: absent = off. Input
    // setup like the channels, so templates keep it.
    if (clip.isMonitoring()) o->setProperty("monitor", true);
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
    // MIDI takes (Q-V4, docs/vst3.md §8): the note sequence lives
    // inline, positions as QTime on the island exchange
    // rate like every other musical fact: [[num, den, byte...], ...]
    // in content order (base-relative — a collapsed take saves as its
    // window, exactly like the WAV path).
    const bool isMidi = clip.contentKind() == ClipNode::ContentKind::Midi;
    const bool hasAudio = sDur > 0 && !isMidi;
    const bool hasMidi = sDur > 0 && isMidi;
    o->setProperty("hasAudio", hasAudio);
    if (hasAudio) writeClipWavs(clip, duration, audioDir, opts.incremental);
    if (isMidi) o->setProperty("contentKind", "midi");
    const int64_t base = clip.getContentBase();
    if (hasMidi) {
      o->setProperty("midi",
                     midiEventsVar(clip.midiSequence(), base, duration, q));
    }
    // The take list (docs/takes.md) — additive keys: absent = one take,
    // no comp. Take k's audio is `<uuid>.take<k>.wav` (take 0 keeps
    // `<uuid>.wav`); MIDI takes ride inline as `midiTakes[k]` (`midi`
    // stays the active one's). The comp names one take per Q cell.
    const int take_count = sDur > 0 ? clip.takeCount() : 0;
    if (take_count > 1) {
      o->setProperty("takes", take_count);
      o->setProperty("activeTake", clip.activeTake());
      if (hasMidi) {
        juce::Array<juce::var> midi_takes;
        for (int k = 0; k < take_count; ++k) {
          const MidiSequence* seq = clip.takeMidi(k);
          midi_takes.add(seq ? midiEventsVar(*seq, base, duration, q)
                             : juce::var(juce::Array<juce::var>()));
        }
        o->setProperty("midiTakes", midi_takes);
      }
    }
    if (const std::vector<int> cells = clip.compCells();
        sDur > 0 && !cells.empty()) {
      juce::Array<juce::var> comp;
      for (const int c : cells) comp.add(c);
      o->setProperty("comp", comp);
      o->setProperty("compCellQ",
                     qvar(timing::fromSamples(clip.compCellLength(), q)));
    }
  } else {
    const auto& stack = static_cast<const StackNode&>(node);
    // No view state is written (I6b): a session carries only musical
    // facts. Loading ignores any view keys an older session carries.
    // THE STACK'S ORIGIN (Q18, composition.md §1) — additive: absent =
    // unanchored, and settleAnchors re-derives from content on load.
    // Stripped with performances like a clip's.
    if (!opts.strip_performances && node.isAnchored()) {
      o->setProperty("anchored", true);
      o->setProperty("originQ", qvar(timing::originQ(node.origin_samples.load(),
                                                     epoch, q)));
    }
    // The SEQUENCE (docs/sequencer.md) — additive block. Stripped with
    // performances: a sequence references committed takes' children
    // and lengths in Q — meaningless pre-Q.
    if (!opts.strip_performances && q > 0) {
      const juce::var so = sequenceVar(stack, q);
      if (!so.isVoid()) o->setProperty("sequence", so);
    }
    juce::Array<juce::var> kids;
    for (const auto& child : stack.ownedChildren())
      kids.add(serializeNode(*child, q, epoch, audioDir, opts));
    o->setProperty("nodes", kids);
  }
  return juce::var(o);
}

std::unique_ptr<AudioNode> deserializeNode(const juce::var& v, int64_t q,
                                           int64_t epoch, double sr,
                                           const juce::File& audioDir) {
  auto* o = v.getDynamicObject();
  if (!o) return nullptr;
  const juce::String type = o->getProperty("type").toString();
  const juce::String uuid = o->getProperty("id").toString();
  const juce::String name = o->getProperty("name").toString();

  std::unique_ptr<AudioNode> node;
  if (type == "stack") {
    auto stack = std::make_unique<StackNode>(name);
    if (auto* kids = o->getProperty("nodes").getArray()) {
      for (const auto& c : *kids)
        if (auto ch = deserializeNode(c, q, epoch, sr, audioDir))
          stack->addChild(std::move(ch));
    }
    // Only the island ROOT owns (Q, epoch); clear any quantum that
    // addChild transiently established on this detached subtree — the
    // engine forces the island values on the real root after attaching.
    stack->setQuantum(0, 0);
    // The SEQUENCE (docs/sequencer.md): rebuild from the additive
    // block. Pre-graph node — no old pointer, no retire needed. Every
    // stack built here is NESTED (the root is the engine's own), so a
    // radio in the block is demoted (root only, S12).
    applySequenceVar(*stack, o->getProperty("sequence"), q,
                     SequenceScope::NESTED,
                     [](const Sequence* old) { delete old; });
    // Q18: an anchored stack's origin is a stored fact; absent key =
    // unanchored (settleAnchors derives one from content after load).
    if ((bool)stack->isAnchored() == false && (bool)o->getProperty("anchored")) {
      stack->setAnchor(
          true, epoch + timing::toSamples(qread(o->getProperty("originQ")), q),
          0);
    }
    node = std::move(stack);
  } else {
    auto clip = std::make_unique<ClipNode>(name, sr);
    const int64_t origin =
        epoch + timing::toSamples(qread(o->getProperty("originQ")), q);
    const int64_t duration =
        timing::toSamples(qread(o->getProperty("periodQ")), q);
    const int64_t ctx =
        timing::toSamples(qread(o->getProperty("contextCycleQ")), q);
    clip->setInputChannel((int)o->getProperty("inputChannel"));
    // Absent key: juce::var() → 0 would silently arm a stereo pair, so
    // default explicitly to −1 (mono).
    clip->setInputChannelRight(o->hasProperty("inputChannelR")
                                   ? (int)o->getProperty("inputChannelR")
                                   : -1);
    // Absent key → false: monitoring is off unless saved on (Q20).
    clip->setMonitoring((bool)o->getProperty("monitor"));
    clip->origin_samples.store(origin);
    clip->duration_samples.store(duration);
    // The take list (docs/takes.md): absent keys = one take. Take 0
    // loads as the active content, later takes append behind it, then
    // the saved selection and comp apply.
    const int take_count = std::max(1, (int)o->getProperty("takes"));
    const bool hasAudio = (bool)o->getProperty("hasAudio");
    const bool isMidi =
        o->getProperty("contentKind").toString() == "midi" && duration > 0;
    auto* midi_takes = o->getProperty("midiTakes").getArray();
    if (hasAudio) {
      juce::AudioBuffer<float> audio;
      if (readClipWav(takeFile(audioDir, uuid, 0), audio))
        clip->loadCommitted(audio, ctx);
      for (int k = 1; k < take_count && k < ClipNode::kMaxTakes; ++k) {
        juce::AudioBuffer<float> take_audio;
        if (readClipWav(takeFile(audioDir, uuid, k), take_audio))
          clip->appendLoadedTake(take_audio);
      }
    } else if (isMidi) {
      // MIDI take: [[num, den, byte...], ...] → content positions in
      // samples through the island exchange rate (Q-V4).
      const juce::var first = midi_takes != nullptr && midi_takes->size() > 0
                                  ? (*midi_takes)[0]
                                  : o->getProperty("midi");
      clip->loadCommittedMidi(parseMidiEvents(first, q), ctx);
      for (int k = 1; k < take_count && k < ClipNode::kMaxTakes; ++k) {
        if (midi_takes == nullptr || k >= midi_takes->size()) break;
        clip->appendLoadedMidiTake(parseMidiEvents((*midi_takes)[k], q));
      }
    }
    if (o->hasProperty("activeTake")) {
      clip->selectTake((int)o->getProperty("activeTake"));
    }
    if (auto* comp = o->getProperty("comp").getArray();
        comp != nullptr && !comp->isEmpty()) {
      std::vector<int> cells;
      for (const auto& c : *comp) cells.push_back((int)c);
      const int64_t cell_len =
          timing::toSamples(qread(o->getProperty("compCellQ")), q);
      if (cell_len > 0) clip->setCompCells(cells, cell_len);
    }
    node = std::move(clip);
  }

  node->setUuid(uuid);
  node->is_muted.store((bool)o->getProperty("muted"));
  node->pan.store((float)(double)o->getProperty("pan"));
  // Absent key MUST default to unity — the missing-property var reads
  // as 0.0, which would load the node silent.
  node->gain.store(
      o->hasProperty("gain") ? (float)(double)o->getProperty("gain") : 1.0f);
  node->period_from_context_.store(o->getProperty("periodSource").toString() ==
                                   "context");
  node->setLoopPoints(
      timing::toSamples(qread(o->getProperty("windowStartQ")), q),
      timing::toSamples(qread(o->getProperty("windowEndQ")), q));
  // Multi-segment map (phase 3): ≥2 entries install an override
  // (pre-graph node: no old pointer, no retire needed); absent/short
  // lists keep the single-window fallback above.
  if (auto* segs = o->getProperty("segmentsQ").getArray();
      segs != nullptr && segs->size() >= 2) {
    timing::TimeMap m;
    for (const auto& sv : *segs) {
      if (m.n >= timing::TimeMap::kMaxSegments) break;
      m.segs[m.n++] = {
          timing::toSamples(qread(sv.getProperty("startQ", {})), q),
          timing::toSamples(qread(sv.getProperty("endQ", {})), q)};
    }
    node->setMap(m);
  }
  node->setLoopWindowBypassed((bool)o->getProperty("loopBypassed"));
  if (auto* stack = dynamic_cast<StackNode*>(node.get());
      stack != nullptr &&
      o->getProperty("windowDomain").toString() == "sequence") {
    stack->setWindowDomain(StackNode::WindowDomain::Sequence);  // S16
  }
  applyEffects(*node, o->getProperty("effects"), sr, nullptr);
  return node;
}

}  // namespace

BundleInfo readBundleInfo(const juce::File& dir) {
  BundleInfo out;
  const auto jf = dir.getChildFile("session.json");
  if (!jf.existsAsFile()) return out;
  const auto root = juce::JSON::parse(jf.loadFileAsString());
  auto* o = root.getDynamicObject();
  if (!o) return out;
  out.ok = true;
  out.name = o->getProperty("name").toString();
  out.created = o->getProperty("created").toString();
  return out;
}

// getMetadata()'s param keys match setParam()'s keys exactly, so restore
// is generic: for each fx, replay enabled + every numeric field.
void applyEffects(AudioNode& node, const juce::var& blob,
                  double sr, const std::function<void(dsp::FxChain*)>& retire) {
  // Array form only (no back-compat): a non-array blob is IGNORED and
  // the node keeps its default chain, rather than erroring the load.
  auto* entries = blob.getArray();
  if (entries == nullptr || entries->isEmpty()) return;

  std::vector<std::shared_ptr<dsp::FxSlot>> slots;
  slots.reserve((size_t)entries->size());
  for (const auto& entry : *entries) {
    auto* o = entry.getDynamicObject();
    if (o == nullptr) continue;
    const juce::String type = o->getProperty("type").toString();
    std::shared_ptr<dsp::FxSlot> slot;
    if (type == "vst3") {
      // Loaded as a PLACEHOLDER (docs/vst3.md §6): identity + state
      // verbatim, hard-bypassed audio. The engine's post-load revival
      // sweep instantiates the real plugin where it is installed;
      // where it isn't, the placeholder round-trips the save intact.
      juce::MemoryBlock state;
      state.fromBase64Encoding(o->getProperty("state").toString());
      slot = std::make_shared<dsp::Vst3Slot>(
          o->getProperty("uid").toString(),
          o->getProperty("name").toString(),
          o->getProperty("file").toString(), state,
          (bool)o->getProperty("isInstrument"),
          o->getProperty("format").toString());  // absent = VST3
      slot->enabled.store((bool)o->getProperty("enabled"));
    } else {
      slot = dsp::FxChain::makeBuiltIn(type);
      if (slot == nullptr) continue;  // unknown type (forward-tolerant)
      slot->prepare(sr);
      for (const auto& p : o->getProperties()) {
        const juce::String key = p.name.toString();
        if (key == "slot" || key == "type") continue;
        if (key == "enabled")
          slot->enabled.store((bool)p.value);
        else
          slot->setParam(key, (double)p.value);
      }
    }
    const juce::String slot_uuid = o->getProperty("slot").toString();
    if (slot_uuid.isNotEmpty()) slot->setSlotUuid(slot_uuid);
    slots.push_back(std::move(slot));
  }
  if (slots.empty()) return;
  dsp::FxChain* old =
      node.exchangeFxChain(dsp::FxChain::makeFromSlots(std::move(slots)).release());
  if (retire)
    retire(old);  // live node (the root on load): reclaimer grace
  else
    delete old;  // pre-graph node: nothing can be reading it
}

bool save(const StackNode& root, double device_sample_rate,
          const juce::File& dir, const SaveOptions& opts) {
  dir.createDirectory();
  const auto audioDir = dir.getChildFile("audio");
  audioDir.createDirectory();

  // Templates are pre-Q by construction (no performances → no grid).
  const int64_t q = opts.strip_performances ? 0 : root.getQuantum();
  const int64_t epoch = opts.strip_performances ? 0 : root.getEpoch();

  auto* top = new juce::DynamicObject();
  top->setProperty("version", kSessionVersion);
  if (opts.display_name.isNotEmpty())
    top->setProperty("name", opts.display_name);
  if (opts.created.isNotEmpty()) top->setProperty("created", opts.created);
  top->setProperty("sampleRate", device_sample_rate);
  top->setProperty("qSamples", (double)q);
  top->setProperty("epoch", (double)epoch);
  top->setProperty("rootMuted", (bool)root.is_muted.load());
  // The root's output stage (the master fader / balance) is bundle-level
  // like its mute and rack: the root is not in `nodes`.
  top->setProperty("rootGain", (double)root.gain.load());
  top->setProperty("rootPan", (double)root.pan.load());
  top->setProperty("rootEffects", effectsBlob(root));
  // The root's own SEQUENCE (the session's song — sequencer.md §10:
  // fractal, root included) is bundle-level like its mute and rack.
  // Pre-Q it has no exchange rate: skipped with the rest of the grid.
  if (!opts.strip_performances && q > 0) {
    const juce::var so = sequenceVar(root, q);
    if (!so.isVoid()) top->setProperty("rootSequence", so);
  }

  juce::Array<juce::var> nodes;
  for (const auto& child : root.ownedChildren())
    nodes.add(serializeNode(*child, q, epoch, audioDir, opts));
  top->setProperty("nodes", nodes);

  const auto json = juce::JSON::toString(juce::var(top), true);
  return dir.getChildFile("session.json").replaceWithText(json);
}

LoadedSession load(const juce::File& dir, double device_sample_rate) {
  LoadedSession out;
  const auto jf = dir.getChildFile("session.json");
  if (!jf.existsAsFile()) return out;

  const auto root = juce::JSON::parse(jf.loadFileAsString());
  auto* o = root.getDynamicObject();
  if (!o) return out;
  // A NEWER bundle is refused (kSessionVersion): loading it as a
  // plausible session and mirroring over it would lose what this build
  // does not understand. Absent = a pre-versioning bundle: loads.
  const int version = (int)o->getProperty("version");
  if (version > kSessionVersion) {
    juce::Logger::writeToLog("session_io: load refused - " +
                             jf.getFullPathName() + " is version " +
                             juce::String(version) + ", this build reads " +
                             juce::String(kSessionVersion));
    return out;
  }

  out.q_samples = (int64_t)(double)o->getProperty("qSamples");
  out.epoch = (int64_t)(double)o->getProperty("epoch");
  out.sample_rate = o->hasProperty("sampleRate")
                        ? (double)o->getProperty("sampleRate")
                        : device_sample_rate;
  out.root_muted = (bool)o->getProperty("rootMuted");
  // Absent = unity / center (bundles written before the master strip).
  out.root_gain = o->hasProperty("rootGain")
                      ? (float)juce::jlimit(0.0, 1.0,
                                            (double)o->getProperty("rootGain"))
                      : 1.0f;
  out.root_pan = o->hasProperty("rootPan")
                     ? (float)juce::jlimit(-1.0, 1.0,
                                           (double)o->getProperty("rootPan"))
                     : 0.0f;
  out.root_effects = o->getProperty("rootEffects");
  out.root_sequence = o->getProperty("rootSequence");
  out.display_name = o->getProperty("name").toString();
  out.created = o->getProperty("created").toString();

  const auto audioDir = dir.getChildFile("audio");
  if (auto* nodes = o->getProperty("nodes").getArray()) {
    for (const auto& n : *nodes)
      if (auto ch = deserializeNode(n, out.q_samples, out.epoch,
                                    out.sample_rate, audioDir))
        out.children.push_back(std::move(ch));
  }
  out.ok = true;
  return out;
}

void applySequenceVar(StackNode& stack, const juce::var& block, int64_t q,
                      SequenceScope scope,
                      const std::function<void(const Sequence*)>& retire) {
  auto* so = block.getDynamicObject();
  if (so == nullptr) return;
  auto seq = std::make_unique<Sequence>();
  if (auto* steps = so->getProperty("steps").getArray()) {
    for (const auto& sv : *steps) {
      if ((int)seq->steps.size() >= Sequence::kMaxSteps) break;
      Sequence::Step st;
      st.len = timing::toSamples(qread(sv.getProperty("lenQ", {})), q);
      st.name = sv.getProperty("name", {}).toString();
      st.cue = (bool)sv.getProperty("cue", false);
      Sequence::readSuccessors(sv, st);
      if (sv.hasProperty("fadeInQ"))
        st.fade_in = timing::toSamples(qread(sv.getProperty("fadeInQ", {})), q);
      if (sv.hasProperty("fadeOutQ"))
        st.fade_out = timing::toSamples(qread(sv.getProperty("fadeOutQ", {})), q);
      if (st.len > 0) seq->steps.push_back(std::move(st));
    }
  }
  seq->seed = (uint32_t)(int64_t)(double)so->getProperty("seed");
  if (auto* g = so->getProperty("gates").getDynamicObject()) {
    for (const auto& p : g->getProperties()) {
      Sequence::GateRow row;
      row.uuid = p.name.toString();
      row.mask = 0;
      if (auto* bits = p.value.getArray()) {
        for (int i = 0; i < bits->size() && i < Sequence::kMaxSteps; ++i) {
          if ((bool)(*bits)[i]) row.mask |= (1ull << i);
        }
      }
      seq->gates.push_back(std::move(row));
    }
  }
  if (!seq->steps.empty()) {
    seq->finalize();
    // ROOT-ONLY RADIO (S12): a nested block that unrolls to a radio
    // keeps its steps and gates but loses its successors.
    if (seq->radio && scope == SequenceScope::NESTED) {
      juce::Logger::writeToLog(
          "session_io: nested stack '" + stack.getName() +
          "' carries a radio; successors dropped (root only, S12)");
      seq->linearize();
    }
    if (const Sequence* old = stack.exchangeSequence(seq.release())) {
      retire(old);
    }
  }
  stack.setSequenceBypassed((bool)so->getProperty("bypassed"));
}

}  // namespace celestrian::session_io
