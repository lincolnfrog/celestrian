#pragma once

/**
 * The project model (docs/projects.md).
 *
 * Three rules:
 *   1. A project is a FOLDER; the folder name (YYYYMMDD-NN) is its ID,
 *      not its name. Renaming edits `name` inside session.json and
 *      never moves the folder. Loading never reads the folder name —
 *      that is what makes a project folder portable.
 *   2. A template is a project with NO PERFORMANCES (structure, names,
 *      inputs, fx — no audio, no Q). Since Q is born from the first
 *      take, a template is pre-Q by construction.
 *   3. Save is a MIRROR, not an event: the project is BORN (dated
 *      folder auto-created) at the first committed take, and from then
 *      on the folder continuously mirrors the session — takes are
 *      written incrementally (immutable after commit), session.json on
 *      every tick. A crash loses at most the take in flight.
 *
 * Message thread only. The app drives `tick()` from a timer; tests call
 * it directly. Roots default under ~/Music/Celestrian and are
 * overridable for tests.
 */

#include <juce_core/juce_core.h>

#include <vector>

class AudioEngine;

namespace celestrian {

class ProjectManager {
 public:
  explicit ProjectManager(AudioEngine& engine) : engine_(engine) {}

  // --- roots ---
  juce::File projectsRoot() const;
  juce::File templatesRoot() const;
  void setRootForTest(const juce::File& base) { base_override_ = base; }

  // --- state ---
  bool born() const { return folder_ != juce::File(); }
  juce::File folder() const { return folder_; }
  juce::String id() const { return born() ? folder_.getFileName() : ""; }
  juce::String displayName() const { return display_name_; }

  /** Heartbeat: births the project at the first committed take, then
   * keeps the folder mirroring the session (incremental). Skips while a
   * take is in flight (transient state is never saved). */
  void tick();

  /** Checkpoint now. Births the project if the user asked to save
   * before the first take (an explicit ⌘S is intent enough). */
  bool saveNow();

  /** Rename: display name only — the folder never moves. */
  void rename(const juce::String& name);

  /** Open a project folder (anywhere on disk — portability rule: the
   * folder name is irrelevant, identity lives inside). */
  bool openProject(const juce::File& dir);

  /** Load a template as a fresh UNBORN session: the seed take will
   * birth (and name) the project. */
  bool newFromTemplate(const juce::String& template_name);

  /** Strip performances from the current session into a template. */
  bool saveAsTemplate(const juce::String& template_name);

  /** Codify the -02 habit: copy the folder to the next free serial and
   * open the copy (fork forward). Returns the new folder (empty on
   * failure / unborn). */
  juce::File duplicateProject();

  struct Info {
    juce::String id;    // folder name
    juce::String name;  // display name (falls back to id)
    juce::String path;
  };
  std::vector<Info> listTemplates() const;
  std::vector<Info> listRecents(int max = 10) const;

  /** The last session template used or saved, persisted in
   * <base>/state.json. Bookkeeping only (Q17): the app boots EMPTY and
   * session templates are an explicit new-from choice — nothing
   * auto-loads this. */
  juce::String lastTemplateName() const;

  // --- Track templates (design_language.md Q17 — the Q7 companion) ---
  // SUBTREE templates: a track or group's structure + names + inputs,
  // saved once from the selection and replayed from the creation menu.
  // A GLOBAL user-level library (they follow the user across projects)
  // — deliberately distinct from the whole-session templates above.
  juce::File trackTemplatesRoot() const;

  /** Capture the node as a template file <root>/<name>.json
   * ({version, name, node} — additive format, see track_template.h).
   * Overwrites an existing template of the same name (re-saving your
   * rig is the expected gesture). False if the node is missing/root or
   * the name sanitizes to nothing. */
  bool saveTrackTemplate(const juce::String& name, const juce::String& uuid);

  struct TrackTemplateInfo {
    juce::String name;
    juce::String kind;  // "clip" | "group"
    int tracks = 0;     // clip-leaf count ("Drums · 5 tracks")
  };
  /** The library, name-sorted (stable menu order beats mtime shuffle). */
  std::vector<TrackTemplateInfo> listTrackTemplates() const;

  /** Insert a fresh subtree from the named template under parent_uuid
   * (empty = top level) — ONE undoable edit, engine-side. */
  bool createFromTrackTemplate(const juce::String& name,
                               const juce::String& parent_uuid);

 private:
  juce::File base() const;
  /** First free YYYYMMDD-NN folder for today, NN from 01. */
  juce::File nextSerialFolder() const;
  /** How the mirror writes take WAVs: INCREMENTAL skips files whose
   * on-disk length already matches (committed audio is immutable);
   * FULL_REWRITE stamps every file — used when a folder must become
   * self-contained (save-as-template / duplicate). */
  enum class MirrorMode { INCREMENTAL, FULL_REWRITE };
  bool mirror(MirrorMode mode);
  void rememberLastTemplate(const juce::String& name);

  AudioEngine& engine_;
  juce::File base_override_;
  juce::File folder_;  // empty = unborn
  juce::String display_name_;
  juce::String created_;
};

}  // namespace celestrian
