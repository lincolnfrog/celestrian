// AudioEngine — the TAKE appliers (docs/takes.md): Take and Untake (a
// performance's content, in and out of its clips), SelectTake,
// DeleteTake and Comp. Take content an edit displaces rides the inverse
// and is retired only with its log entry (retireEdit). Message thread
// only.

#include "../audio_engine.h"

#include "../clip_node.h"
#include "../dsp/vst3_slot.h"
#include "../stack_node.h"
#include "edit_internal.h"

namespace {
using celestrian::ClipNode;
using celestrian::Edit;
using celestrian::StackNode;
using celestrian::edit_internal::captureIsland;

/** A take left the list at index `gone`: comp cells naming it fall back
 * to the active take, cells above it renumber, and a comp that names
 * nothing any more clears. */
void dropTakeFromComp(ClipNode& clip, int gone) {
  std::vector<int> cells = clip.compCells();
  if (cells.empty()) return;
  bool names_a_take = false;
  for (int& cell : cells) {
    if (cell == gone) cell = -1;
    else if (cell > gone) --cell;
    if (cell >= 0) names_a_take = true;
  }
  if (names_a_take) {
    clip.setCompCells(cells, clip.compCellLength(), clip.compCellOffset());
  } else {
    clip.setCompCells({}, 0);
  }
}
}  // namespace

Edit AudioEngine::applyTake(Edit e) {
  // Untake strips the named clips, its inverse Take OWNING their content;
  // Take reinstalls it. A payload with a take index names a take of a
  // multi-take slot instead: Untake removes that LAST take and restores
  // the one active before it, Take appends it as the active one — the
  // slot keeps its content either way.
  const bool strip = e.kind == Edit::Kind::Untake;
  Edit inv(strip ? Edit::Kind::Take : Edit::Kind::Untake);
  // ALL OR NOTHING: every payload is judged before anything changes (a
  // deleted clip's take went with it — Remove owns that).
  std::vector<ClipNode*> clips;
  for (const auto& payload : e.takes) {
    auto* clip = dynamic_cast<ClipNode*>(findNodeByUuid(payload.uuid));
    if (!clip) return {};
    if (!strip && !payload.state.buffer) return {};
    const bool committed = clip->duration_samples.load() > 0;
    if (payload.take_index >= 0) {
      if (!committed) return {};
      const int expected_count =
          strip ? payload.take_index + 1 : payload.take_index;
      if (clip->takeCount() != expected_count) return {};
      if (strip && payload.take_index < 1) return {};
    } else if (strip ? (!committed || clip->takeCount() > 1) : committed) {
      return {};
    }
    clips.push_back(clip);
  }
  captureIsland(*root_node, inv);
  for (size_t i = 0; i < clips.size(); ++i) {
    ClipNode& clip = *clips[i];
    Edit::TakePayload& in = e.takes[i];
    Edit::TakePayload out;
    out.uuid = in.uuid;
    out.take_index = in.take_index;
    out.prev_active = in.prev_active;
    if (in.take_index >= 0) {
      // The slot's re-time rides the take: the inverse takes the current
      // one, the payload's lands after the list change.
      out.setsRetime = true;
      out.retime = clip.retime();
      if (strip) {
        // The comp rides the inverse; meanwhile cells naming the removed
        // take fall back to the active one.
        out.setsComp = true;
        out.cells = clip.compCells();
        out.cell_len = clip.compCellLength();
        out.cell_off = clip.compCellOffset();
        if (in.prev_active >= 0 && in.prev_active != clip.activeTake()) {
          clip.selectTake(in.prev_active);
        }
        out.state = clip.removeTake(in.take_index);
        dropTakeFromComp(clip, in.take_index);
      } else {
        clip.insertTake(in.take_index, std::move(in.state));
        clip.selectTake(in.take_index);
        if (in.setsComp) clip.setCompCells(in.cells, in.cell_len, in.cell_off);
      }
      if (in.setsRetime) clip.setRetime(in.retime);
    } else if (strip) {
      out.state = clip.stripTake();
    } else {
      auto displaced = clip.restoreTake(std::move(in.state));
      retireOwned(displaced.first.release());
      retireOwned(displaced.second.release());
    }
    // A MIDI take's instrument (vst3.md §8.4): the inverse takes the
    // state current now, the payload's goes live. A slot no longer on the
    // chain drops the rider.
    if (in.instrument_slot.isNotEmpty()) {
      if (auto* instrument = dynamic_cast<celestrian::dsp::Vst3Slot*>(
              clip.fxChain()->findSlot(in.instrument_slot))) {
        out.instrument_slot = in.instrument_slot;
        out.instrument_state = instrument->stateBlob();
        if (in.instrument_state.getSize() > 0) {
          instrument->restoreState(in.instrument_state);
        }
      }
    }
    inv.takes.push_back(std::move(out));
  }
  // What rides a performance, both ways: the island's (Q, zero) — a
  // first take's establishment undoes with it — the member windows a
  // group take's settle moved, and the step-record auto-gate (`uuid` +
  // `seq` under `b1`: the stack's sequence swaps with the take).
  //
  // A PERFORMANCE MOVES NO SONG. The facts are set bare, never through
  // setIslandQuantum: an Untake is applied only to the graph its take
  // left, so every song it meets was authored before the take, over the
  // island with no Q it goes back to — and stays as the take found it.
  if (e.setsIsland) root_node->setQuantum(e.iq, e.izero);
  applyWindowRiders(e, inv);
  if (e.b1 && e.uuid.isNotEmpty()) {
    if (auto* stack = dynamic_cast<StackNode*>(findNodeByUuid(e.uuid))) {
      inv.b1 = true;
      inv.uuid = e.uuid;
      inv.seq = swapSequence(*stack, e.seq.get());
    }
  }
  return inv;
}

Edit AudioEngine::applySelectTake(Edit e) {
  auto* clip = dynamic_cast<ClipNode*>(findNodeByUuid(e.uuid));
  if (!clip || e.index < 0 || e.index >= clip->takeCount() ||
      e.index == clip->activeTake()) {
    return {};
  }
  Edit inv(Edit::Kind::SelectTake);
  inv.uuid = e.uuid;
  inv.index = clip->activeTake();
  if (!clip->selectTake(e.index)) return {};
  return inv;
}

Edit AudioEngine::applyDeleteTake(Edit e) {
  auto* clip = dynamic_cast<ClipNode*>(findNodeByUuid(e.uuid));
  if (!clip) return {};
  Edit inv(Edit::Kind::DeleteTake);
  inv.uuid = e.uuid;
  if (e.takes.empty()) {
    // Forward: detach take `index` (never a slot's last). The inverse
    // owns the record, with the activity and the comp to restore.
    const int gone = e.index;
    if (clip->takeCount() < 2 || gone < 0 || gone >= clip->takeCount()) {
      return {};
    }
    // ALL OR NOTHING, judged before anything is detached: every take of
    // the slot holds content — the removed one to ride the inverse, a
    // neighbour to take over from an active one. (No path leaves a list
    // otherwise; the active take's content is the clip's own.)
    for (int k = 0; k < clip->takeCount(); ++k) {
      if (clip->takeBuffer(k) == nullptr) return {};
    }
    Edit::TakePayload payload;
    payload.uuid = e.uuid;
    payload.take_index = gone;
    payload.prev_active = clip->activeTake();
    payload.setsComp = true;
    payload.cells = clip->compCells();
    payload.cell_len = clip->compCellLength();
    payload.cell_off = clip->compCellOffset();
    payload.state = clip->removeTake(gone);
    dropTakeFromComp(*clip, gone);
    inv.takes.push_back(std::move(payload));
    return inv;
  }
  // With a payload: the record goes back where it was.
  Edit::TakePayload& payload = e.takes[0];
  if (!payload.state.buffer || payload.take_index < 0 ||
      payload.take_index > clip->takeCount()) {
    return {};
  }
  clip->insertTake(payload.take_index, std::move(payload.state));
  if (payload.prev_active >= 0) clip->selectTake(payload.prev_active);
  if (payload.setsComp) {
    clip->setCompCells(payload.cells, payload.cell_len, payload.cell_off);
  }
  inv.index = payload.take_index;
  return inv;
}

Edit AudioEngine::applyComp(Edit e) {
  auto* clip = dynamic_cast<ClipNode*>(findNodeByUuid(e.uuid));
  if (!clip) return {};
  Edit inv(Edit::Kind::Comp);
  inv.uuid = e.uuid;
  inv.cells = clip->compCells();
  inv.cell_len = clip->compCellLength();
  inv.cell_off = clip->compCellOffset();
  clip->setCompCells(e.cells, e.cell_len, e.cell_off);
  return inv;
}
