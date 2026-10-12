// The session bundle format (session_io.h). A node's record is written
// by serializeNode and read in two halves: deserializeNode builds the
// node and its content, applyNodeFacts applies everything else — to a
// node just built, or to the engine's live root. save / load are the
// bundle level.

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

// A stack's SEQUENCE block (docs/sequencer.md): steps as QTime lengths
// with cue, successors and fades, the seed, gates keyed by child uuid,
// the bypass flag. Void when the stack has none.
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
    if (st.cue) stepo->setProperty("cue", true);
    if (!st.next.empty())
      stepo->setProperty("next", Sequence::successorsVar(st));
    // Per-step fades (S13): musical lengths, QTime like lenQ.
    if (st.fade_in > 0)
      stepo->setProperty("fadeInQ", qvar(timing::fromSamples(st.fade_in, q)));
    if (st.fade_out > 0)
      stepo->setProperty("fadeOutQ", qvar(timing::fromSamples(st.fade_out, q)));
    steps.add(juce::var(stepo));
  }
  so->setProperty("steps", steps);
  if (s->seed != 0) so->setProperty("seed", (double)s->seed);
  auto* gateso = new juce::DynamicObject();
  for (const auto& row : s->gates) {
    juce::Array<juce::var> bits;
    for (int i = 0; i < s->numSteps(); ++i) bits.add(s->on(row.mask, i));
    gateso->setProperty(row.uuid, bits);
  }
  so->setProperty("gates", juce::var(gateso));
  return juce::var(so);
}

// A node's rack: the chain's metadata IS the save format (docs/vst3.md
// §6), with each plugin slot's state blob added.
juce::var effectsBlob(const AudioNode& node) {
  return node.fxChain()->getMetadata(/*include_persistent_state=*/true);
}

/** One take's WAV: the COMMITTED content [base, base + duration) of
 * `buf` (a Q13-collapsed take saves as its window; the cut material is
 * undo state, not session state). `skip_existing` leaves a file that is
 * already there alone. False when the file had to be written and could
 * not be. */
bool writeTakeWav(const juce::AudioBuffer<float>& buf, int64_t base,
                  int64_t duration, double sample_rate, const juce::File& file,
                  bool skip_existing) {
  const int n =
      (int)std::min<int64_t>(duration, (int64_t)buf.getNumSamples() - base);
  if (n <= 0) return true;  // nothing committed to write
  if (skip_existing && file.existsAsFile()) return true;
  file.getParentDirectory().createDirectory();
  // WRITE-THEN-SWAP: written beside the target and moved over it only
  // once complete, so a crash or a full disk mid-write leaves the
  // committed take's file intact.
  juce::TemporaryFile temp(file);
  {
    juce::WavAudioFormat fmt;
    std::unique_ptr<juce::FileOutputStream> stream(
        temp.getFile().createOutputStream());
    if (!stream) return false;
    // 32-bit float: the recorded buffer round-trips losslessly.
    std::unique_ptr<juce::AudioFormatWriter> writer(fmt.createWriterFor(
        stream.get(), sample_rate,
        (unsigned int)std::max(1, buf.getNumChannels()), 32, {}, 0));
    if (!writer) return false;
    stream.release();  // the writer owns the stream now
    if (!writer->writeFromAudioSampleBuffer(buf, (int)base, n)) return false;
    // The writer flushes and closes on destruction (end of scope).
  }
  return temp.overwriteTargetFileWithTemporary();
}

/** Take k's file (docs/takes.md): take 0 keeps `<uuid>.wav`, later
 * takes are `<uuid>.take<k>.wav`. */
juce::File takeFile(const juce::File& audioDir, const juce::String& uuid,
                    int k) {
  return audioDir.getChildFile(
      k == 0 ? uuid + ".wav" : uuid + ".take" + juce::String(k) + ".wav");
}

/** Every take of the clip; false when one could not be written.
 *
 * The MIRROR (`incremental`, SaveOptions) leaves an existing file alone
 * unless the clip says its files are stale (ClipNode::takeFilesDirty,
 * set by every edit that changes which samples a take's file holds —
 * the file's length cannot tell: a collapse to [Q, 2Q) and one to
 * [0, Q) are as long). Then every take is rewritten and files past the
 * count go. A failed write leaves the mark for the next tick. */
bool writeClipWavs(const ClipNode& clip, int64_t duration,
                   const juce::File& audioDir, bool incremental) {
  const int64_t base = clip.getContentBase();
  const int count = clip.takeCount();
  const bool rewrite = !incremental || clip.takeFilesDirty();
  bool all_written = true;
  for (int k = 0; k < count; ++k) {
    const juce::AudioBuffer<float>* buf = clip.takeBuffer(k);
    if (buf == nullptr) continue;
    all_written &= writeTakeWav(*buf, base, duration, clip.getSampleRate(),
                                takeFile(audioDir, clip.getUuid(), k),
                                /*skip_existing=*/!rewrite);
  }
  if (rewrite) {
    // Files past the count exist only after the list shrank.
    for (int k = std::max(1, count); k < ClipNode::kMaxTakes; ++k) {
      const juce::File stale = takeFile(audioDir, clip.getUuid(), k);
      if (stale.existsAsFile()) stale.deleteFile();
    }
  }
  if (incremental && all_written) clip.markTakeFilesWritten();
  return all_written;
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
  // A file that exists but will not open (permissions, a lock) yields no
  // stream, and the WAV reader does not accept a null one.
  auto stream = file.createInputStream();
  if (stream == nullptr) return false;
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::AudioFormatReader> reader(
      fmt.createReaderFor(stream.release(), true));
  if (!reader) return false;
  const int len = (int)reader->lengthInSamples;
  const int chans = std::max(1, (int)reader->numChannels);
  out.setSize(chans, len);
  reader->read(&out, 0, len, 0, /*useReaderLeftChan=*/true,
               /*useReaderRightChan=*/chans >= 2);
  return true;
}

/** An object a load displaced off a node: to `retire` for a LIVE node
 * (the engine reclaimer — the audio thread may still read it), deleted
 * inline for a pre-graph one (`retire` null). */
template <typename T>
void retireOrDelete(T* displaced, const std::function<void(T*)>& retire) {
  if (displaced == nullptr) return;
  if (retire)
    retire(displaced);
  else
    delete displaced;
}

/** `node`'s rack from its record's `effects` array (effectsBlob;
 * fillParams' keys are setParam's, so the replay is generic). No array,
 * or one with no slot this build knows, is the default rack. Built-in
 * slots are prepared at `rack_rate` before the chain is published. */
void applyEffects(AudioNode& node, const juce::var& blob, double rack_rate,
                  const std::function<void(dsp::FxChain*)>& retire) {
  std::vector<std::shared_ptr<dsp::FxSlot>> slots;
  if (auto* entries = blob.getArray()) {
    slots.reserve((size_t)entries->size());
    for (const auto& entry : *entries) {
      auto* o = entry.getDynamicObject();
      if (o == nullptr) continue;
      const juce::String type = o->getProperty("type").toString();
      std::shared_ptr<dsp::FxSlot> slot;
      if (type == "vst3") {
        // Loaded as a PLACEHOLDER (Vst3Slot); the host's revival sweep
        // swaps the real plugin in where it is installed.
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
        slot->prepare(rack_rate);
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
  }
  auto chain = slots.empty() ? dsp::FxChain::makeDefault()
                             : dsp::FxChain::makeFromSlots(std::move(slots));
  retireOrDelete(node.exchangeFxChain(chain.release()), retire);
}

/** `stack`'s song from its record's `sequence` block (sequenceVar's
 * shape), materialized against `q`. A LENIENT read (Sequence::fromVar):
 * what the block spells wrong is left out and the rest loads; no block,
 * or one that keeps no step, is no song. The bypass flag is the block's
 * either way. A NESTED block that unrolls to a radio keeps its steps and
 * gates and loses its successors (SequenceScope). */
void applySequenceVar(StackNode& stack, const juce::var& block, int64_t q,
                      SequenceScope scope,
                      const std::function<void(const Sequence*)>& retire) {
  Sequence::Dropped dropped;
  auto seq = Sequence::fromVar(
      block, Sequence::kQKeys,
      [q](const juce::var& v) { return timing::toSamples(qread(v), q); },
      dropped);
  if (dropped.any()) {
    juce::Logger::writeToLog("session_io: the song of '" + stack.getName() +
                             "' loaded in part - " + dropped.what());
  }
  if (seq != nullptr && seq->radio && scope == SequenceScope::NESTED) {
    juce::Logger::writeToLog(
        "session_io: nested stack '" + stack.getName() +
        "' carries a radio; successors dropped (root only, S12)");
    seq->linearize();
  }
  retireOrDelete(stack.exchangeSequence(seq.release()), retire);
  stack.setSequenceBypassed((bool)block.getProperty("bypassed", false));
}

/** `node`'s record, its subtree's beneath it; a clip's take WAVs are
 * written into `audioDir` on the way. `wavs_written` turns false (and
 * stays so) when one of them could not be. */
juce::var serializeNode(const AudioNode& node, int64_t q, int64_t zero,
                        const juce::File& audioDir, const SaveOptions& opts,
                        bool& wavs_written) {
  auto* o = new juce::DynamicObject();
  o->setProperty("id", node.getUuid());
  o->setProperty("name", node.getName());
  o->setProperty("type", node.getNodeTypeString());
  o->setProperty("muted", (bool)node.is_muted.load());
  o->setProperty("pan", (double)node.pan.load());
  o->setProperty("gain", (double)node.gain.load());
  // The Q5 period source: absent = "own" (a loop).
  if (node.period_from_context_.load())
    o->setProperty("periodSource", "context");

  // THE PERFORMANCE FACTS every node has, which a template strips: the
  // window (or the multi-segment map — `segmentsQ`, two or more
  // {startQ, endQ} pairs), its bypass, a stack's window domain (S16,
  // docs/sequencer.md §11.8; absent = intrinsic), the top and the
  // re-time.
  o->setProperty("loopBypassed",
                 opts.strip_performances ? false : node.isLoopWindowBypassed());
  if (!opts.strip_performances && node.getNodeType() == NodeType::Stack) {
    const auto& stack = static_cast<const StackNode&>(node);
    if (stack.windowDomain() == StackNode::WindowDomain::Sequence)
      o->setProperty("windowDomain", "sequence");
  }
  const int64_t ws = opts.strip_performances ? 0 : node.getLoopStart();
  const int64_t we = opts.strip_performances ? 0 : node.getLoopEnd();
  o->setProperty("windowStartQ", qvar(timing::fromSamples(ws, q)));
  o->setProperty("windowEndQ", qvar(timing::fromSamples(we, q)));
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
    // The top and the re-time (loop_selection.md §9): the top a raw
    // inner position, the re-time a signed offset of the origin. An
    // unset top and a node as played write nothing.
    if (const int64_t top = node.storedTop(); top != timing::kNoTop)
      o->setProperty("loopTopQ", qvar(timing::fromSamples(top, q)));
    if (const int64_t retime = node.retime(); retime != 0)
      o->setProperty("retimeQ", qvar(timing::fromSamples(retime, q)));
  }
  o->setProperty("effects", effectsBlob(node));

  if (node.getNodeType() == NodeType::Clip) {
    const auto& clip = static_cast<const ClipNode&>(node);
    const int64_t origin = node.origin_samples.load();
    const int64_t duration = node.duration_samples.load();
    o->setProperty("inputChannel", clip.getInputChannel());
    o->setProperty("inputChannelR", clip.getInputChannelRight());
    // Input monitoring (Q20) is input setup like the channels: a
    // template keeps it.
    if (clip.isMonitoring()) o->setProperty("monitor", true);
    // The origin as an OFFSET FROM THE ZERO, the period, the context
    // cycle. Stripped, the clip persists as a named, wired, EMPTY track.
    const int64_t sOrigin = opts.strip_performances ? 0 : origin;
    const int64_t sDur = opts.strip_performances ? 0 : duration;
    o->setProperty("originQ", qvar(timing::originQ(sOrigin, zero, q)));
    o->setProperty("periodQ", qvar(timing::periodQ(sDur, q)));
    o->setProperty("contextCycleQ",
                   qvar(timing::fromSamples(
                       opts.strip_performances ? 0 : clip.contextCycle(), q)));
    // A MIDI take (Q-V4, docs/vst3.md §8) is inline (midiEventsVar); an
    // audio take is a WAV.
    const bool isMidi = clip.contentKind() == ClipNode::ContentKind::Midi;
    const bool hasAudio = sDur > 0 && !isMidi;
    const bool hasMidi = sDur > 0 && isMidi;
    o->setProperty("hasAudio", hasAudio);
    if (hasAudio &&
        !writeClipWavs(clip, duration, audioDir, opts.incremental)) {
      wavs_written = false;
      juce::Logger::writeToLog("session_io: could not write the audio of '" +
                               clip.getName() + "' into " +
                               audioDir.getFullPathName());
    }
    if (isMidi) o->setProperty("contentKind", "midi");
    const int64_t base = clip.getContentBase();
    if (hasMidi) {
      o->setProperty("midi",
                     midiEventsVar(clip.midiSequence(), base, duration, q));
    }
    // The take list (docs/takes.md): absent = one take, no comp. MIDI
    // takes are `midiTakes[k]` (`midi` stays the active one's); the
    // comp names one take per cell.
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
    // The stack's origin (Q18, composition.md §1): absent = unanchored,
    // and the engine's settleAnchors derives one from content on load.
    if (!opts.strip_performances && node.isAnchored()) {
      o->setProperty("anchored", true);
      o->setProperty("originQ", qvar(timing::originQ(node.origin_samples.load(),
                                                     zero, q)));
    }
    // The song: its steps are lengths in Q, meaningless pre-Q.
    if (!opts.strip_performances && q > 0) {
      const juce::var so = sequenceVar(stack, q);
      if (!so.isVoid()) o->setProperty("sequence", so);
    }
    juce::Array<juce::var> kids;
    for (const auto& child : stack.ownedChildren())
      kids.add(serializeNode(*child, q, zero, audioDir, opts, wavs_written));
    o->setProperty("nodes", kids);
  }
  return juce::var(o);
}

/** The node a record describes, its subtree beneath it. Two rates:
 * `content_rate` is the one the bundle's takes were recorded at (a
 * clip's own), `rack_rate` the one the device runs at — what the racks
 * process, whatever the bundle was saved at. */
std::unique_ptr<AudioNode> deserializeNode(const juce::var& v, int64_t q,
                                           int64_t zero, double content_rate,
                                           double rack_rate,
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
        if (auto ch = deserializeNode(c, q, zero, content_rate, rack_rate,
                                      audioDir))
          stack->addChild(std::move(ch));
    }
    if ((bool)stack->isAnchored() == false && (bool)o->getProperty("anchored")) {
      stack->setAnchor(
          true, zero + timing::toSamples(qread(o->getProperty("originQ")), q),
          0);
    }
    node = std::move(stack);
  } else {
    auto clip = std::make_unique<ClipNode>(name, content_rate);
    const int64_t origin =
        zero + timing::toSamples(qread(o->getProperty("originQ")), q);
    const int64_t duration =
        timing::toSamples(qread(o->getProperty("periodQ")), q);
    const int64_t ctx =
        timing::toSamples(qread(o->getProperty("contextCycleQ")), q);
    clip->setInputChannel((int)o->getProperty("inputChannel"));
    // An absent key reads as 0, which would arm a stereo pair: −1 (mono).
    clip->setInputChannelRight(o->hasProperty("inputChannelR")
                                   ? (int)o->getProperty("inputChannelR")
                                   : -1);
    clip->setMonitoring((bool)o->getProperty("monitor"));
    clip->origin_samples.store(origin);
    clip->duration_samples.store(duration);
    // Take 0 loads as the active content, later takes append behind it,
    // then the saved selection and comp apply.
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
        if (!readClipWav(takeFile(audioDir, uuid, k), take_audio)) {
          // A take whose file is gone keeps its SLOT, silent: the saved
          // active take and comp cells name takes by index.
          take_audio.setSize(1, (int)duration);
          take_audio.clear();
          juce::Logger::writeToLog("session_io: take " + juce::String(k) +
                                   " of '" + name +
                                   "' has no readable audio - loaded silent");
        }
        clip->appendLoadedTake(take_audio);
      }
    } else if (isMidi) {
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

  // A node built here is pre-graph (null retirers: nothing reads what
  // it displaces) and NESTED (the root is the engine's own).
  applyNodeFacts(*node, v, q, rack_rate, SequenceScope::NESTED, nullptr,
                 nullptr);
  return node;
}

/** A version-1 bundle's root as a node record: the bundle-level `root*`
 * keys and `nodes` under the node keys. Absent keys stay absent, so
 * applyNodeFacts' defaults apply. */
juce::var legacyRootRecord(const juce::DynamicObject& o) {
  auto* r = new juce::DynamicObject();
  r->setProperty("type", "stack");
  r->setProperty("muted", o.getProperty("rootMuted"));
  if (o.hasProperty("rootGain")) r->setProperty("gain", o.getProperty("rootGain"));
  if (o.hasProperty("rootPan")) r->setProperty("pan", o.getProperty("rootPan"));
  r->setProperty("effects", o.getProperty("rootEffects"));
  r->setProperty("sequence", o.getProperty("rootSequence"));
  r->setProperty("nodes", o.getProperty("nodes"));
  return juce::var(r);
}

}  // namespace

void applyNodeFacts(AudioNode& node, const juce::var& record, int64_t q,
                    double rack_rate, SequenceScope scope,
                    const std::function<void(dsp::FxChain*)>& retire_fx,
                    const std::function<void(const Sequence*)>& retire_seq) {
  auto* o = record.getDynamicObject();
  if (o == nullptr) return;
  if (const juce::String uuid = o->getProperty("id").toString();
      uuid.isNotEmpty()) {
    node.setUuid(uuid);
  }
  node.is_muted.store((bool)o->getProperty("muted"));
  node.pan.store((float)(double)o->getProperty("pan"));
  // An absent key reads as 0.0, which would load the node silent: unity.
  node.gain.store(
      o->hasProperty("gain") ? (float)(double)o->getProperty("gain") : 1.0f);
  node.period_from_context_.store(o->getProperty("periodSource").toString() ==
                                  "context");
  node.setLoopPoints(
      timing::toSamples(qread(o->getProperty("windowStartQ")), q),
      timing::toSamples(qread(o->getProperty("windowEndQ")), q));
  // A clip's window over its whole content restricts nothing (some
  // bundles carry one on every committed clip): it loads as no window,
  // so in memory a take is its whole content unless trimmed.
  if (node.getNodeType() == NodeType::Clip) {
    const int64_t D = node.getIntrinsicDuration();
    if (D > 0 && node.getLoopStart() <= 0 && node.getLoopEnd() >= D &&
        !node.hasSegmentMap()) {
      node.setLoopPoints(0, 0);
    }
  }
  // Two or more segments are the map; fewer leave the window above.
  if (auto* segs = o->getProperty("segmentsQ").getArray();
      segs != nullptr && segs->size() >= 2) {
    timing::TimeMap m;
    for (const auto& sv : *segs) {
      if (m.n >= timing::TimeMap::kMaxSegments) break;
      m.segs[m.n++] = {
          timing::toSamples(qread(sv.getProperty("startQ", {})), q),
          timing::toSamples(qread(sv.getProperty("endQ", {})), q)};
    }
    node.setMap(m);
  }
  // The top and the re-time, as saved: a load is not a map edit, so
  // nothing reconciles the top against the map.
  node.setStoredTop(o->hasProperty("loopTopQ")
                        ? timing::toSamples(qread(o->getProperty("loopTopQ")), q)
                        : timing::kNoTop);
  node.setRetime(o->hasProperty("retimeQ")
                     ? timing::toSamples(qread(o->getProperty("retimeQ")), q)
                     : 0);
  node.setLoopWindowBypassed((bool)o->getProperty("loopBypassed"));
  if (auto* stack = dynamic_cast<StackNode*>(&node)) {
    stack->setWindowDomain(
        o->getProperty("windowDomain").toString() == "sequence"
            ? StackNode::WindowDomain::Sequence
            : StackNode::WindowDomain::Intrinsic);
    stack->setAuditionStep(-1);
    applySequenceVar(*stack, o->getProperty("sequence"), q, scope, retire_seq);
  }
  applyEffects(node, o->getProperty("effects"), rack_rate, retire_fx);
}

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

bool save(const StackNode& root, double device_sample_rate,
          const juce::File& dir, const SaveOptions& opts) {
  dir.createDirectory();
  const auto audioDir = dir.getChildFile("audio");
  audioDir.createDirectory();

  // Templates are pre-Q by construction (no performances → no grid).
  const int64_t q = opts.strip_performances ? 0 : root.getQuantum();
  const int64_t zero = opts.strip_performances ? 0 : root.getZero();

  auto* top = new juce::DynamicObject();
  top->setProperty("version", kSessionVersion);
  if (opts.display_name.isNotEmpty())
    top->setProperty("name", opts.display_name);
  if (opts.created.isNotEmpty()) top->setProperty("created", opts.created);
  top->setProperty("sampleRate", device_sample_rate);
  // The island facts, then the root as one node record (session_io.h).
  top->setProperty("qSamples", (double)q);
  top->setProperty("zero", (double)zero);
  // The Q hand-off's designation (Q22): written only when set, never on
  // a template (pre-Q, nothing to designate).
  if (!opts.strip_performances && root.definerDesignation().isNotEmpty())
    top->setProperty("definer", root.definerDesignation());
  bool wavs_written = true;
  top->setProperty("root",
                   serializeNode(root, q, zero, audioDir, opts, wavs_written));

  // session.json is written even when a take's audio was not: the facts
  // it carries are current, and the unwritten take stays dirty on its
  // clip for the next mirror.
  const auto json = juce::JSON::toString(juce::var(top), true);
  return dir.getChildFile("session.json").replaceWithText(json) &&
         wavs_written;
}

LoadedSession load(const juce::File& dir, double device_sample_rate,
                   int64_t clock) {
  LoadedSession out;
  const auto jf = dir.getChildFile("session.json");
  if (!jf.existsAsFile()) return out;

  const auto root = juce::JSON::parse(jf.loadFileAsString());
  auto* o = root.getDynamicObject();
  if (!o) return out;
  // A NEWER bundle is refused (kSessionVersion); an unversioned one loads.
  const int version = (int)o->getProperty("version");
  if (version > kSessionVersion) {
    juce::Logger::writeToLog("session_io: load refused - " +
                             jf.getFullPathName() + " is version " +
                             juce::String(version) + ", this build reads " +
                             juce::String(kSessionVersion));
    return out;
  }

  out.q_samples = (int64_t)(double)o->getProperty("qSamples");
  out.zero = (int64_t)(double)(o->hasProperty("zero")
                                   ? o->getProperty("zero")
                                   : o->getProperty("epoch"));
  // A zero ahead of this run's clock would sit the whole island in the
  // future (arms would wait for it, the recording view would fold a
  // negative phase). It is seated at the clock BEFORE any origin below
  // is resolved from it, so the island moves as one.
  if (out.zero > clock) out.zero = clock;
  if (o->hasProperty("definer")) out.definer = o->getProperty("definer").toString();
  out.sample_rate = o->hasProperty("sampleRate")
                        ? (double)o->getProperty("sampleRate")
                        : device_sample_rate;
  out.root = o->getProperty("root").isObject() ? o->getProperty("root")
                                                : legacyRootRecord(*o);
  if (auto* r = out.root.getDynamicObject();
      r != nullptr && (bool)r->getProperty("anchored")) {
    out.root_anchored = true;
    out.root_origin =
        out.zero + timing::toSamples(qread(r->getProperty("originQ")),
                                      out.q_samples);
  }

  const auto audioDir = dir.getChildFile("audio");
  if (auto* nodes = out.root.getProperty("nodes", {}).getArray()) {
    for (const auto& n : *nodes)
      if (auto ch = deserializeNode(n, out.q_samples, out.zero,
                                    out.sample_rate, device_sample_rate,
                                    audioDir))
        out.children.push_back(std::move(ch));
  }
  out.ok = true;
  return out;
}

}  // namespace celestrian::session_io
