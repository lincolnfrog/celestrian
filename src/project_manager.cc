#include "project_manager.h"

#include "audio_engine.h"
#include "session_io.h"
#include "track_template.h"

// IDENTITY. The current project is three fields, set together:
//   folder_        empty = unborn (nothing is mirrored)
//   display_name_  the name inside session.json; rename() sets it alone
//   created_       the creation stamp inside session.json
// by birth() (flush at the first committed take, or saveNow: the next
// serial folder, named after it, stamped now), openProject (the folder
// and what its session.json says), newFromTemplate and closeProject (all
// three empty: unborn again) and duplicateProject (the folder alone — the
// copy keeps its name and stamp).
//
// ONE SIDE FILE, outside any project:
//   <app data>/Celestrian/projects_root.json  {"base": path}
//       the base folder the user chose (setBase)

namespace celestrian {

juce::File ProjectManager::baseChoiceFile() {
  return juce::File::getSpecialLocation(
             juce::File::userApplicationDataDirectory)
      .getChildFile("Celestrian")
      .getChildFile("projects_root.json");
}

// The base folder, in this order: the test override; the user's
// persisted choice (read from disk once); ~/Music/Celestrian. The
// override SHADOWS the choice: while it stands, setBase answers true
// and moves nothing (the headless server always sets one).
juce::File ProjectManager::base() const {
  if (base_override_ != juce::File()) return base_override_;
  if (!chosen_base_read_) {
    chosen_base_read_ = true;
    const juce::File f = baseChoiceFile();
    if (f.existsAsFile()) {
      const juce::var v = juce::JSON::parse(f.loadFileAsString());
      const juce::String path = v.getProperty("base", "").toString();
      if (path.isNotEmpty()) chosen_base_ = juce::File(path);
    }
  }
  if (chosen_base_ != juce::File()) return chosen_base_;
  return juce::File::getSpecialLocation(juce::File::userMusicDirectory)
      .getChildFile("Celestrian");
}

bool ProjectManager::setBase(const juce::File& dir) {
  if (dir == juce::File() || !dir.createDirectory()) return false;
  chosen_base_ = dir;
  chosen_base_read_ = true;
  // Under the test override nothing is persisted, and base() keeps
  // answering the override.
  if (base_override_ != juce::File()) return true;
  auto* o = new juce::DynamicObject();
  o->setProperty("base", dir.getFullPathName());
  const juce::File f = baseChoiceFile();
  f.getParentDirectory().createDirectory();
  const bool ok = f.replaceWithText(juce::JSON::toString(juce::var(o), true));
  juce::Logger::writeToLog("ProjectManager: base folder -> " +
                           dir.getFullPathName() + (ok ? "" : " (not persisted)"));
  return true;
}

// The three root getters (this, templatesRoot, trackTemplatesRoot) make
// sure their directory exists on EVERY call — and the UI's project-info
// poll calls two of them every couple of seconds.
juce::File ProjectManager::projectsRoot() const {
  auto d = base().getChildFile("Projects");
  d.createDirectory();
  return d;
}

juce::File ProjectManager::templatesRoot() const {
  auto d = base().getChildFile("Templates");
  d.createDirectory();
  return d;
}

juce::File ProjectManager::nextSerialFolder() const {
  const auto date = juce::Time::getCurrentTime().formatted("%Y%m%d");
  for (int nn = 1; nn < 100; ++nn) {
    auto candidate = projectsRoot().getChildFile(
        date + "-" + juce::String(nn).paddedLeft('0', 2));
    if (!candidate.exists()) return candidate;
  }
  // 99 projects in one day: fall back to a unique suffix rather than fail.
  return projectsRoot().getChildFile(
      date + "-" + juce::String(juce::Time::currentTimeMillis() % 100000));
}

// THE ONE WRITER of the project folder. False when the session is
// unborn (nothing is written) or session.json or a take's wav could
// not be written — the failed take stays dirty on its clip and the next
// mirror retries it. saveNow hands the answer to the user; flush (the
// heartbeat) drops it.
bool ProjectManager::mirror(MirrorMode mode) {
  if (!born()) return false;
  session_io::SaveOptions opts;
  opts.display_name = display_name_;
  opts.created = created_;
  opts.incremental = mode == MirrorMode::INCREMENTAL;
  return engine_.saveSessionTo(folder_, opts);
}

void ProjectManager::birth() {
  folder_ = nextSerialFolder();
  display_name_ = folder_.getFileName();
  created_ = juce::Time::getCurrentTime().toISO8601(true);
  juce::Logger::writeToLog("ProjectManager: project born - " +
                           folder_.getFullPathName());
}

void ProjectManager::tick() {
  // Transient capture state is never saved; try again next tick.
  if (engine_.hasActiveTake()) return;

  // Return arm-time virtual reservations to exact size (idle committed
  // takes only; cheap no-op when there is nothing to do).
  engine_.compactIdleTakes();

  flush();
}

void ProjectManager::flush() {
  // Transient capture state is never saved.
  if (engine_.hasActiveTake()) return;
  if (!born()) {
    // BIRTH at the first committed take (docs/projects.md): the moment there
    // is a performance worth keeping, it is on disk — crash-safe from
    // the seed take on. Junk sessions are a delete, not a lost save.
    if (engine_.islandCommittedClipCount() == 0) return;
    birth();
  }
  mirror(MirrorMode::INCREMENTAL);
}

bool ProjectManager::saveNow() {
  // Explicit save before the first take: intent enough to birth.
  if (!born()) birth();
  return mirror(MirrorMode::INCREMENTAL);
}

void ProjectManager::rename(const juce::String& name) {
  display_name_ = name.trim().isEmpty() ? id() : name.trim();
  if (born()) mirror(MirrorMode::INCREMENTAL);  // persist the name only
}

bool ProjectManager::openProject(const juce::File& dir) {
  flush();  // the session about to be replaced reaches its folder first
  if (!engine_.loadSession(dir.getFullPathName())) return false;
  folder_ = dir;
  const auto info = session_io::readBundleInfo(dir);
  display_name_ = info.name.isNotEmpty() ? info.name : dir.getFileName();
  created_ = info.created;
  return true;
}

bool ProjectManager::newFromTemplate(const juce::String& template_id) {
  flush();  // the session about to be replaced reaches its folder first
  const auto dir = templatesRoot().getChildFile(template_id);
  if (!engine_.loadSession(dir.getFullPathName())) return false;
  // Unborn: the seed take births (and dates) the project.
  forgetIdentity();
  return true;
}

void ProjectManager::closeProject() {
  flush();  // the session being let go reaches its folder first
  forgetIdentity();
}

void ProjectManager::forgetIdentity() {
  folder_ = juce::File();
  display_name_ = "";
  created_ = "";
}

bool ProjectManager::saveAsTemplate(const juce::String& template_name) {
  // The folder is an ID, never the name (rule 1): the typed name lives
  // inside session.json, the folder is its legal-file-name form. A name
  // with nothing legal in it, or one that is only a path step ("."
  // / ".."), names no folder of its own and is refused.
  const auto name = template_name.trim();
  const auto folder_name = juce::File::createLegalFileName(name);
  if (folder_name.isEmpty() || folder_name.containsOnly(".")) return false;
  session_io::SaveOptions opts;
  opts.display_name = name;
  opts.created = juce::Time::getCurrentTime().toISO8601(true);
  opts.strip_performances = true;
  return engine_.saveSessionTo(templatesRoot().getChildFile(folder_name), opts);
}

// --- Track templates (Q17 — the Q7 companion) ------------------------

juce::File ProjectManager::trackTemplatesRoot() const {
  auto d = base().getChildFile("TrackTemplates");
  d.createDirectory();
  return d;
}

bool ProjectManager::saveTrackTemplate(const juce::String& name,
                                       const juce::String& uuid) {
  const auto trimmed = name.trim();
  const auto legal = juce::File::createLegalFileName(trimmed);
  if (trimmed.isEmpty() || legal.isEmpty()) return false;
  const juce::var node = engine_.captureTrackTemplate(uuid);
  if (node.isVoid()) return false;
  auto* o = new juce::DynamicObject();
  o->setProperty("version", 1);  // additive format: absent keys = defaults
  o->setProperty("name", trimmed);
  o->setProperty("node", node);
  return trackTemplatesRoot()
      .getChildFile(legal + ".json")
      .replaceWithText(juce::JSON::toString(juce::var(o), false));
}

std::vector<ProjectManager::TrackTemplateInfo>
ProjectManager::listTrackTemplates() const {
  std::vector<TrackTemplateInfo> out;
  auto files = trackTemplatesRoot().findChildFiles(juce::File::findFiles,
                                                   false, "*.json");
  files.sort();
  for (const auto& f : files) {
    const auto v = juce::JSON::parse(f.loadFileAsString());
    const auto node = v.getProperty("node", juce::var());
    if (node.isVoid()) continue;  // unreadable file: skip, never crash
    TrackTemplateInfo info;
    info.name = v.getProperty("name", f.getFileNameWithoutExtension())
                    .toString();
    info.kind =
        node.getProperty("type", "clip").toString() == "stack" ? "group"
                                                               : "clip";
    info.tracks = track_templates::countClips(node);
    out.push_back(std::move(info));
  }
  return out;
}

bool ProjectManager::createFromTrackTemplate(const juce::String& name,
                                             const juce::String& parent_uuid) {
  const auto legal = juce::File::createLegalFileName(name.trim());
  const auto f = trackTemplatesRoot().getChildFile(legal + ".json");
  if (!f.existsAsFile()) return false;
  const auto v = juce::JSON::parse(f.loadFileAsString());
  const auto node = v.getProperty("node", juce::var());
  if (node.isVoid()) return false;
  return engine_.insertTrackTemplate(node, parent_uuid);
}

juce::File ProjectManager::duplicateProject() {
  if (!born()) return {};
  mirror(MirrorMode::INCREMENTAL);  // copy must include the latest state
  const auto dest = nextSerialFolder();
  if (!folder_.copyDirectoryTo(dest)) return {};
  // Fork FORWARD: keep working in the copy; the original stays as the
  // checkpoint (the -02 habit, codified).
  folder_ = dest;
  mirror(MirrorMode::FULL_REWRITE);  // stamp the mirror as this folder's own
  return dest;
}

static std::vector<ProjectManager::Info> listBundles(const juce::File& root) {
  std::vector<ProjectManager::Info> out;
  for (const auto& entry : juce::RangedDirectoryIterator(
           root, false, "*", juce::File::findDirectories)) {
    const auto dir = entry.getFile();
    const auto info = session_io::readBundleInfo(dir);
    if (!info.ok) continue;
    out.push_back({dir.getFileName(),
                   info.name.isNotEmpty() ? info.name : dir.getFileName(),
                   dir.getFullPathName()});
  }
  return out;
}

std::vector<ProjectManager::Info> ProjectManager::listTemplates() const {
  return listBundles(templatesRoot());
}

// Only <base>/Projects is listed: a project opened from anywhere else
// is never "recent".
std::vector<ProjectManager::Info> ProjectManager::listRecents(int max) const {
  auto all = listBundles(projectsRoot());
  // IDs are date-serial, so lexicographic descending = newest first.
  std::sort(all.begin(), all.end(),
            [](const Info& a, const Info& b) { return a.id > b.id; });
  if ((int)all.size() > max) all.resize((size_t)max);
  return all;
}

}  // namespace celestrian
