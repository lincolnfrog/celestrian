// ClipNode — the content model (takes.md): the take list and the comp,
// a new take's arm and settle, strip / restore, the lock-collapse and
// the splice, session load and import. MESSAGE THREAD throughout, on an
// Idle clip unless a function says otherwise; the audio thread sees the
// list only through the take table (publishTakeTable).

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>

#include "clip_node.h"
#include "timing.h"

namespace celestrian {

namespace {
/** THE SPLICE COPY, one body for every take of a slot: `m`'s segments,
 * read behind `base`, concatenated into an exact `period`-sized buffer
 * of `chans` channels (a MIDI take keeps a one-sample buffer).
 * `source(inner, run)` names the buffer holding the material at inner
 * position `inner` and may shorten `run`, the samples it holds from
 * there — one buffer throughout for a plain take, the comp's pick cell
 * by cell for a comp'd slot. */
template <typename Source>
std::unique_ptr<juce::AudioBuffer<float>> spliceBuffer(
    int chans, int64_t base, const timing::TimeMap& m, bool midi,
    Source&& source) {
  auto spliced = std::make_unique<juce::AudioBuffer<float>>(
      chans, midi ? 1 : (int)m.period());
  spliced->clear();
  int64_t w = 0;
  for (int i = 0; i < (midi ? 0 : m.n); ++i) {
    const int64_t s = m.segs[i].start;
    const int64_t len = m.segs[i].end - s;
    for (int64_t done = 0; done < len;) {
      int64_t run = len - done;
      const juce::AudioBuffer<float>& src = source(s + done, run);
      const int64_t from = base + s + done;
      const int64_t avail = std::clamp<int64_t>(src.getNumSamples() - from, 0,
                                                std::max<int64_t>(run, 0));
      for (int c = 0; c < chans && avail > 0; ++c) {
        spliced->copyFrom(c, (int)(w + done), src,
                          std::min(c, src.getNumChannels() - 1), (int)from,
                          (int)avail);
      }
      done += std::max<int64_t>(run, 1);
    }
    w += len;
  }
  return spliced;
}

/** The note twin: events inside the kept cells move to their spliced
 * positions; the rest are cut. */
std::unique_ptr<MidiSequence> spliceSequence(const MidiSequence& src,
                                             int64_t base,
                                             const timing::TimeMap& m) {
  std::vector<MidiEvent> kept;
  kept.reserve((size_t)src.count());
  int64_t w = 0;
  for (int i = 0; i < m.n; ++i) {
    const int64_t s = m.segs[i].start;
    const int64_t len = m.segs[i].end - s;
    for (int k = 0; k < src.count(); ++k) {
      const int64_t rel = src[k].pos - base - s;
      if (rel >= 0 && rel < len) {
        MidiEvent e = src[k];
        e.pos = w + rel;
        kept.push_back(e);
      }
    }
    w += len;
  }
  auto spliced = std::make_unique<MidiSequence>();
  spliced->assign(std::move(kept));
  return spliced;
}

/** An exact-size copy of `audio` (at least one channel, one sample). */
std::unique_ptr<juce::AudioBuffer<float>> copyOf(
    const juce::AudioBuffer<float>& audio) {
  const int n = audio.getNumSamples();
  const int chans = std::max(1, audio.getNumChannels());
  auto copy = std::make_unique<juce::AudioBuffer<float>>(chans, std::max(1, n));
  copy->clear();
  for (int c = 0; c < chans && n > 0; ++c) copy->copyFrom(c, 0, audio, c, 0, n);
  return copy;
}
}  // namespace

// --- The take table and the comp --------------------------------------

void ClipNode::publishTakeTable() {
  take_lock_.write([&](int slot) {
    TakeTableCopy& c = take_[slot];
    const int n = std::min<int>(kMaxTakes, (int)takes_.size());
    c.count.store(n, std::memory_order_relaxed);
    for (int i = 0; i < kMaxTakes; ++i) {
      const juce::AudioBuffer<float>* b =
          i < n ? takes_[(size_t)i].buffer.get() : nullptr;
      c.buffers[i].store(b, std::memory_order_relaxed);
      c.recorded[i].store(i < n ? takes_[(size_t)i].recorded : 0,
                          std::memory_order_relaxed);
    }
  });
}

void ClipNode::setCompCells(const std::vector<int>& cells, int64_t cell_len,
                            int64_t cell_offset) {
  const int n = cell_len > 0 ? std::min<int>(kMaxCompCells, (int)cells.size())
                             : 0;
  take_lock_.write([&](int slot) {
    TakeTableCopy& t = take_[slot];
    t.comp_n.store(n, std::memory_order_relaxed);
    t.comp_q.store(n > 0 ? cell_len : 0, std::memory_order_relaxed);
    t.comp_off.store(n > 0 ? cell_offset : 0, std::memory_order_relaxed);
    for (int i = 0; i < kMaxCompCells; ++i) {
      const int c = i < n ? cells[(size_t)i] : -1;
      t.comp_cells[i].store((int8_t)std::clamp(c, -1, kMaxTakes - 1),
                            std::memory_order_relaxed);
    }
  });
}

void ClipNode::shiftComp(int64_t delta) {
  if (take_[0].comp_n.load() <= 0 || delta == 0) return;
  const int64_t moved = take_[0].comp_off.load() + delta;
  take_lock_.write([&](int slot) {
    take_[slot].comp_off.store(moved, std::memory_order_relaxed);
  });
}

std::vector<int> ClipNode::compCells() const {
  std::vector<int> out;
  const int n = std::clamp(take_[0].comp_n.load(), 0, kMaxCompCells);
  out.reserve((size_t)n);
  for (int i = 0; i < n; ++i) out.push_back(take_[0].comp_cells[i].load());
  return out;
}

// --- The take list ----------------------------------------------------

int ClipNode::takeCount() const {
  if (duration_samples.load() <= 0) return 0;
  return std::max<int>(1, (int)takes_.size());
}

void ClipNode::ensureTakeList() {
  if (takes_.empty()) {
    takes_.emplace_back();  // the active slot, empty
    active_take_.store(0);
  }
}

ClipNode::TakeState ClipNode::emptyTake(ContentKind kind) const {
  TakeState empty;
  empty.buffer = makeEmptyContent();
  empty.midi = std::make_unique<MidiSequence>(0);
  empty.content_kind = (int)kind;
  return empty;
}

ClipNode::TakeState ClipNode::exchangeLive(TakeState&& in) {
  TakeState out;
  out.recorded = write_position.load();
  out.content_kind = content_kind_.load();
  out.storage = releaseStorage();
  take_storage_ = std::move(in.storage);
  storage_rt_.store(take_storage_.get());
  content_kind_.store(in.content_kind);
  write_position.store(in.recorded);
  // The pointers are never null: a record without one side gets the
  // empty stand-in for it.
  out.midi = swapMidi(in.midi != nullptr ? std::move(in.midi)
                                         : std::make_unique<MidiSequence>(0));
  out.buffer = swapContent(in.buffer != nullptr ? std::move(in.buffer)
                                                : makeEmptyContent());
  return out;
}

const juce::AudioBuffer<float>* ClipNode::takeBuffer(int k) const {
  if (k < 0 || k >= takeCount()) return nullptr;
  if (k == activeTake()) return content_.load();
  return takes_[(size_t)k].buffer.get();
}

const MidiSequence* ClipNode::takeMidi(int k) const {
  if (k < 0 || k >= takeCount()) return nullptr;
  if (k == activeTake()) return midi_.load();
  return takes_[(size_t)k].midi.get();
}

bool ClipNode::selectTake(int k) {
  if (recState() != RecState::Idle) return false;
  if (k < 0 || k >= takeCount() || k == activeTake()) return false;
  ensureTakeList();
  if (takes_[(size_t)k].buffer == nullptr) return false;
  // The displaced content lives on in the list.
  TakeState was_live = exchangeLive(std::move(takes_[(size_t)k]));
  takes_[(size_t)activeTake()] = std::move(was_live);
  active_take_.store(k);
  publishTakeTable();
  return true;
}

ClipNode::TakeState ClipNode::removeTake(int k) {
  TakeState out;
  if (recState() != RecState::Idle || takeCount() < 2) return out;
  if (k < 0 || k >= takeCount()) return out;
  ensureTakeList();
  if (k == activeTake()) selectTake(k > 0 ? k - 1 : 1);
  out = std::move(takes_[(size_t)k]);
  takes_.erase(takes_.begin() + k);
  if (activeTake() > k) active_take_.store(activeTake() - 1);
  take_files_dirty_ = true;
  // The table drops the pointer BEFORE the caller may retire the record.
  publishTakeTable();
  return out;
}

void ClipNode::insertTake(int k, TakeState&& s) {
  if (recState() != RecState::Idle) return;
  ensureTakeList();
  k = std::clamp<int>(k, 0, (int)takes_.size());
  takes_.insert(takes_.begin() + k, std::move(s));
  if (activeTake() >= k) active_take_.store(activeTake() + 1);
  take_files_dirty_ = true;
  publishTakeTable();
}

void ClipNode::appendLoadedTake(const juce::AudioBuffer<float>& audio) {
  ensureTakeList();
  TakeState s;
  s.buffer = copyOf(audio);
  s.midi = std::make_unique<MidiSequence>(0);
  s.recorded = audio.getNumSamples();
  s.content_kind = (int)ContentKind::Audio;
  takes_.push_back(std::move(s));
  publishTakeTable();
}

void ClipNode::appendLoadedMidiTake(std::vector<MidiEvent> events) {
  ensureTakeList();
  TakeState s;
  s.buffer = std::make_unique<juce::AudioBuffer<float>>(1, 1);
  s.buffer->clear();
  s.midi = std::make_unique<MidiSequence>();
  s.midi->assign(std::move(events));
  s.recorded = duration_samples.load();
  s.content_kind = (int)ContentKind::Midi;
  takes_.push_back(std::move(s));
  publishTakeTable();
}

// --- A new take of a committed slot -----------------------------------

bool ClipNode::mayRetake() const {
  if (recState() != RecState::Idle || duration_samples.load() <= 0) return false;
  if (takeCount() >= kMaxTakes) return false;
  // The chain decides the next take's kind.
  return fxChain()->hasInstrumentSlot() == (contentKind() == ContentKind::Midi);
}

ClipNode::TakeState ClipNode::prepareRetake() {
  jassert(mayRetake());
  const bool next_midi = contentKind() == ContentKind::Midi;
  const int64_t period = duration_samples.load();
  // Silence first, then the active content parks in its list slot.
  is_playing.store(false);
  ensureTakeList();
  takes_[(size_t)activeTake()] = exchangeLive(emptyTake(contentKind()));
  publishTakeTable();
  // The take's storage displaces the stand-in just installed.
  TakeState displaced = reserveTakeStorage(0);
  retake_period_.store(period);
  // The new take lands at the shared base: everything an uncollapse
  // could later expose — [0, base) ahead of it and the old extent of a
  // collapsed slot — is committed, then zeroed.
  if (!next_midi) {
    commitTakeReach(getEffectiveQuantum());
    clearTakeSpan(std::max<int64_t>(content_base_.load() + period,
                                    collapsed_from_.load()));
  }
  retake_committed_.store(false);
  retake_cancelled_.store(false);
  live_duration_samples.store(0);
  return displaced;
}

bool ClipNode::settleRetake(TakeState& displaced) {
  if (retake_committed_.load()) {
    retake_committed_.store(false);
    ensureTakeList();
    takes_.emplace_back();  // the new active slot, empty: its content is live
    active_take_.store((int)takes_.size() - 1);
    publishTakeTable();
    return true;
  }
  if (retake_cancelled_.load()) {
    retake_cancelled_.store(false);
    ensureTakeList();
    // The abandoned reservation goes to the caller; the previous active
    // take comes back from its slot and sounds again.
    displaced = exchangeLive(std::move(takes_[(size_t)activeTake()]));
    live_duration_samples.store(duration_samples.load());
    publishTakeTable();
    is_playing.store(true);
  }
  return false;
}

// --- Strip / restore --------------------------------------------------

ClipNode::TakeState ClipNode::stripTake() {
  // Silence first: render reads duration and is_playing before content.
  const int64_t duration = duration_samples.load();
  is_playing.store(false);
  duration_samples.store(0);
  TakeState s = exchangeLive(emptyTake(ContentKind::Audio));
  s.duration = duration;
  s.origin = origin_samples.load();
  s.base = content_base_.load();
  s.context_cycle = take_context_cycle_.load();
  s.loop_start = getLoopStart();
  s.loop_end = getLoopEnd();
  s.collapsed_from = collapsed_from_.load();
  s.top = loop_top_.load();
  s.retime = retime_.load();
  // An empty clip: no origin, no window, no top, nothing re-timed.
  origin_samples.store(0);
  content_base_.store(0);
  take_context_cycle_.store(0);
  cap_hit_.store(false);
  collapsed_from_.store(0);
  setLoopPoints(0, 0);
  loop_top_.store(timing::kNoTop);
  retime_.store(0);
  rec_state_.store((int)RecState::Idle);
  // Only a single-take clip is stripped (the applier gates): the list
  // and the comp go with the content.
  takes_.clear();
  active_take_.store(0);
  setCompCells({}, 0);
  publishTakeTable();
  take_files_dirty_ = true;
  return s;
}

std::pair<std::unique_ptr<juce::AudioBuffer<float>>,
          std::unique_ptr<MidiSequence>>
ClipNode::restoreTake(TakeState&& s) {
  const int64_t duration = s.duration;
  content_base_.store(s.base);
  take_context_cycle_.store(s.context_cycle);
  collapsed_from_.store(s.collapsed_from);
  origin_samples.store(s.origin);
  setLoopPoints(s.loop_start, s.loop_end);
  loop_top_.store(s.top);
  retime_.store(s.retime);
  rec_state_.store((int)RecState::Idle);
  // An empty clip may still hold a cancelled arm's reservation: it goes
  // with `displaced` here, the placeholders go back to the caller.
  TakeState displaced = exchangeLive(std::move(s));
  // The commit's order: duration last, then sound.
  duration_samples.store(duration);
  is_playing.store(true);
  take_files_dirty_ = true;
  return {std::move(displaced.buffer), std::move(displaced.midi)};
}

// --- The lock-collapse ------------------------------------------------

void ClipNode::collapseContent(int64_t shift, int64_t len) {
  // The marker keeps the ORIGINAL duration, set at the first level only
  // (a second collapse is legal: collapse, cancel the take, re-trim, arm
  // again). What the levels shifted by in all IS content_base_.
  if (collapsed_from_.load() == 0) collapsed_from_.store(duration_samples.load());
  content_base_.store(content_base_.load() + shift);
  duration_samples.store(len);
  setLoopPoints(0, 0);  // consumed: the take IS the window
  // The top and the comp name stretches of the recording, which now sit
  // `shift` earlier in the take. A plain shift, exactly invertible: a
  // top outside the consumed window stays stored (effectiveTop masks it).
  if (const int64_t t = loop_top_.load(); t != timing::kNoTop) {
    loop_top_.store(t - shift);
  }
  shiftComp(-shift);
  take_files_dirty_ = true;
}

void ClipNode::uncollapseContent(int64_t shift, int64_t old_duration) {
  const int64_t len = duration_samples.load();
  content_base_.store(content_base_.load() - shift);
  duration_samples.store(old_duration);
  setLoopPoints(shift, shift + len);
  if (const int64_t t = loop_top_.load(); t != timing::kNoTop) {
    loop_top_.store(t + shift);
  }
  shiftComp(shift);
  // Fully unwound — the content view back at 0 — is not collapsed.
  if (content_base_.load() == 0) collapsed_from_.store(0);
  take_files_dirty_ = true;
}

// --- The splice -------------------------------------------------------

std::unique_ptr<juce::AudioBuffer<float>> ClipNode::spliceToMap(
    const timing::TimeMap& m,
    const std::vector<std::pair<int, TakeState>>* pre_splice) {
  const int64_t period = m.period();
  const juce::AudioBuffer<float>& active = *content_.load();
  // A MIDI clip's content is its notes (spliceMidiToMap): its audio
  // buffer stays minimal.
  const bool midi = contentKind() == ContentKind::Midi;
  // What the comp SOUNDED over each kept stretch — runSource's rule: a
  // cell naming no other take's material reads the active take.
  const std::vector<int> cells = compCells();
  const int64_t cell_len = compCellLength();
  const int64_t cell_off = compCellOffset();
  const auto sounding =
      [&](int64_t inner, int64_t& run) -> const juce::AudioBuffer<float>& {
    if (cells.empty() || cell_len <= 0) return active;
    if (inner < cell_off) {  // ahead of the first cell
      run = std::min(run, cell_off - inner);
      return active;
    }
    const int64_t cell = (inner - cell_off) / cell_len;
    run = std::min(run, cell_off + (cell + 1) * cell_len - inner);
    const int pick = cell < (int64_t)cells.size() ? cells[(size_t)cell] : -1;
    if (pick < 0 || pick == activeTake() || pre_splice == nullptr) return active;
    for (const auto& [index, record] : *pre_splice) {
      if (index == pick && record.buffer != nullptr &&
          record.buffer->getNumSamples() > 0) {
        return *record.buffer;
      }
    }
    return active;
  };
  auto spliced = spliceBuffer(std::max(1, active.getNumChannels()),
                              content_base_.load(), m, midi, sounding);
  setCompCells({}, 0);
  origin_samples.store(origin_samples.load() + m.mapOffset(0));
  duration_samples.store(period);
  setLoopPoints(0, 0);  // the kept cells ARE the take: whole is no window
  // THE TOP rides the splice: raw T lands at its heard offset in the
  // spliced take, so with origin += a0 it keeps its moment. A stored top
  // the map does not play was not the effective one — the region start
  // stood in — and the splice puts that at 0, where the top stays a
  // fact (only a take never edited is unset).
  if (const int64_t t = loop_top_.load(); t != timing::kNoTop) {
    const int64_t h = m.heardOffsetOf(t);
    loop_top_.store(h >= 0 ? h : 0);
  }
  // The spliced buffer is the whole take: no base, no collapse marker.
  content_base_.store(0);
  collapsed_from_.store(0);
  write_position.store(period);
  take_files_dirty_ = true;
  return swapContent(std::move(spliced));
}

std::unique_ptr<juce::AudioBuffer<float>> ClipNode::unspliceFromMap(
    std::unique_ptr<juce::AudioBuffer<float>> old_buffer, int64_t old_origin,
    int64_t old_duration, int64_t old_base, int64_t old_recorded,
    int64_t old_collapsed_from, int64_t old_top) {
  auto displaced = swapContent(std::move(old_buffer));
  origin_samples.store(old_origin);
  duration_samples.store(old_duration);
  setLoopPoints(0, 0);  // whole, until the caller puts the cut map back
  loop_top_.store(old_top);
  content_base_.store(old_base);
  collapsed_from_.store(old_collapsed_from);
  write_position.store(old_recorded);
  take_files_dirty_ = true;
  return displaced;
}

std::unique_ptr<MidiSequence> ClipNode::spliceMidiToMap(
    const timing::TimeMap& m) {
  return swapMidi(spliceSequence(*midi_.load(), content_base_.load(), m));
}

std::unique_ptr<MidiSequence> ClipNode::unspliceMidi(
    std::unique_ptr<MidiSequence> old_sequence) {
  return swapMidi(std::move(old_sequence));
}

std::vector<std::pair<int, ClipNode::TakeState>>
ClipNode::spliceOtherTakesToMap(const timing::TimeMap& m) {
  std::vector<std::pair<int, TakeState>> old;
  const int64_t base = content_base_.load();
  for (int k = 0; k < (int)takes_.size(); ++k) {
    TakeState& s = takes_[(size_t)k];
    if (k == activeTake() || s.buffer == nullptr) continue;
    const bool midi = s.content_kind == (int)ContentKind::Midi;
    TakeState fresh;
    const juce::AudioBuffer<float>& own = *s.buffer;
    fresh.buffer = spliceBuffer(
        std::max(1, own.getNumChannels()), base, m, midi,
        [&own](int64_t, int64_t&) -> const juce::AudioBuffer<float>& {
          return own;
        });
    fresh.midi = midi && s.midi ? spliceSequence(*s.midi, base, m)
                                : std::make_unique<MidiSequence>(0);
    fresh.recorded = m.period();
    fresh.content_kind = s.content_kind;
    old.emplace_back(k, std::move(s));
    s = std::move(fresh);
  }
  if (!old.empty()) publishTakeTable();
  return old;
}

std::vector<ClipNode::TakeState> ClipNode::unspliceOtherTakes(
    std::vector<std::pair<int, TakeState>>&& old) {
  std::vector<TakeState> displaced;
  for (auto& [k, s] : old) {
    if (k < 0 || k >= (int)takes_.size() || k == activeTake()) continue;
    displaced.push_back(std::move(takes_[(size_t)k]));
    takes_[(size_t)k] = std::move(s);
  }
  if (!displaced.empty()) publishTakeTable();
  return displaced;
}

// --- Session load and import ------------------------------------------

void ClipNode::loadCommitted(const juce::AudioBuffer<float>& audio,
                             int64_t context_cycle) {
  // An empty file keeps the placeholder; the node is not yet in the
  // live graph, so what the swap displaces is dropped here.
  if (audio.getNumSamples() > 0) {
    swapContent(copyOf(audio));
  } else {
    content_.load()->clear();
  }
  write_position.store(audio.getNumSamples());
  take_context_cycle_.store(context_cycle);
  rec_state_.store((int)RecState::Idle);
  is_playing.store(true);
}

void ClipNode::loadCommittedMidi(std::vector<MidiEvent> events,
                                 int64_t context_cycle) {
  auto fresh = std::make_unique<MidiSequence>();
  fresh->assign(std::move(events));
  swapMidi(std::move(fresh));  // not yet in the live graph: dropped here
  content_kind_.store((int)ContentKind::Midi);
  write_position.store(duration_samples.load());
  take_context_cycle_.store(context_cycle);
  rec_state_.store((int)RecState::Idle);
  is_playing.store(true);
}

std::unique_ptr<juce::AudioBuffer<float>> ClipNode::installImportedTake(
    std::unique_ptr<juce::AudioBuffer<float>> audio, int64_t origin,
    int64_t duration, int64_t loop_end, int64_t context_cycle) {
  const int64_t recorded = audio->getNumSamples();
  auto displaced = swapContent(std::move(audio));
  // The commit's order: origin, base and window first, duration last,
  // then sound.
  origin_samples.store(origin);
  content_base_.store(0);
  write_position.store(recorded);
  take_context_cycle_.store(context_cycle);
  setLoopPoints(0, loop_end);
  rec_state_.store((int)RecState::Idle);
  duration_samples.store(duration);
  is_playing.store(true);
  take_files_dirty_ = true;
  return displaced;
}

}  // namespace celestrian
