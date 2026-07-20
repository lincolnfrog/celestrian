#pragma once

/**
 * The project model (docs/projects.md — owner-ratified 2026-07-19f).
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
  explicit ProjectManager(AudioEngine &engine) : engine_(engine) {}

  // --- roots ---
  juce::File projectsRoot() const;
  juce::File templatesRoot() const;
  void setRootForTest(const juce::File &base) { base_override_ = base; }

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
  void rename(const juce::String &name);

  /** Open a project folder (anywhere on disk — portability rule: the
   * folder name is irrelevant, identity lives inside). */
  bool openProject(const juce::File &dir);

  /** Load a template as a fresh UNBORN session: the seed take will
   * birth (and name) the project. */
  bool newFromTemplate(const juce::String &template_name);

  /** Strip performances from the current session into a template. */
  bool saveAsTemplate(const juce::String &template_name);

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

  // --- Default template (the Ableton launch ritual) ---
  /** The last template used or saved, persisted in <base>/state.json. */
  juce::String lastTemplateName() const;
  /** Launch ritual: with an empty session and a remembered template on
   * disk, load it — the app boots instrument-ready, zero clicks to
   * record. Unborn as ever: the seed take dates the project. */
  bool autoLoadLastTemplate();

 private:
  juce::File base() const;
  /** First free YYYYMMDD-NN folder for today, NN from 01. */
  juce::File nextSerialFolder() const;
  bool mirror(bool incremental);
  void rememberLastTemplate(const juce::String &name);

  AudioEngine &engine_;
  juce::File base_override_;
  juce::File folder_;  // empty = unborn
  juce::String display_name_;
  juce::String created_;
};

}  // namespace celestrian
