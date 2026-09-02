#include "project_manager.h"

#include "audio_engine.h"
#include "session_io.h"
#include "track_template.h"

namespace celestrian {

juce::File ProjectManager::base() const {
  if (base_override_ != juce::File()) return base_override_;
  return juce::File::getSpecialLocation(juce::File::userMusicDirectory)
      .getChildFile("Celestrian");
}

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

bool ProjectManager::mirror(MirrorMode mode) {
  if (!born()) return false;
  session_io::SaveOptions opts;
  opts.display_name = display_name_;
  opts.created = created_;
  opts.incremental = mode == MirrorMode::INCREMENTAL;
  return engine_.saveSessionTo(folder_, opts);
}

void ProjectManager::tick() {
  // Transient capture state is never saved; try again next tick.
  if (engine_.hasActiveTake()) return;

  // Return arm-time virtual reservations to exact size (idle committed
  // takes only; cheap no-op when there is nothing to do).
  engine_.compactIdleTakes();

  if (!born()) {
    // BIRTH at the first committed take (docs/projects.md): the moment there
    // is a performance worth keeping, it is on disk — crash-safe from
    // the seed take on. Junk sessions are a delete, not a lost save.
    if (engine_.islandCommittedClipCount() == 0) return;
    folder_ = nextSerialFolder();
    display_name_ = folder_.getFileName();
    created_ = juce::Time::getCurrentTime().toISO8601(true);
    juce::Logger::writeToLog("ProjectManager: project born - " +
                             folder_.getFullPathName());
  }
  mirror(MirrorMode::INCREMENTAL);
}

bool ProjectManager::saveNow() {
  if (!born()) {
    // Explicit save before the first take: intent enough to birth.
    folder_ = nextSerialFolder();
    display_name_ = folder_.getFileName();
    created_ = juce::Time::getCurrentTime().toISO8601(true);
  }
  return mirror(MirrorMode::INCREMENTAL);
}

void ProjectManager::rename(const juce::String& name) {
  display_name_ = name.trim().isEmpty() ? id() : name.trim();
  if (born()) mirror(MirrorMode::INCREMENTAL);  // persist the name only
}

bool ProjectManager::openProject(const juce::File& dir) {
  if (!engine_.loadSession(dir.getFullPathName())) return false;
  folder_ = dir;
  const auto info = session_io::readBundleInfo(dir);
  display_name_ = info.name.isNotEmpty() ? info.name : dir.getFileName();
  created_ = info.created;
  return true;
}

bool ProjectManager::newFromTemplate(const juce::String& template_name) {
  const auto dir = templatesRoot().getChildFile(template_name);
  if (!engine_.loadSession(dir.getFullPathName())) return false;
  // Unborn: the seed take births (and dates) the project.
  folder_ = juce::File();
  display_name_ = "";
  created_ = "";
  rememberLastTemplate(template_name);
  return true;
}

void ProjectManager::rememberLastTemplate(const juce::String& name) {
  auto* o = new juce::DynamicObject();
  o->setProperty("lastTemplate", name);
  base().createDirectory();
  base()
      .getChildFile("state.json")
      .replaceWithText(juce::JSON::toString(juce::var(o), true));
}

juce::String ProjectManager::lastTemplateName() const {
  const auto f = base().getChildFile("state.json");
  if (!f.existsAsFile()) return {};
  const auto v = juce::JSON::parse(f.loadFileAsString());
  return v.getProperty("lastTemplate", "").toString();
}

// The app boots EMPTY (Q17): no launch session is seeded and no template
// auto-loads. Every + is a template picker, `R` on an empty project
// creates + arms the default track, and session templates are an
// explicit save-as / new-from choice.

bool ProjectManager::saveAsTemplate(const juce::String& template_name) {
  const auto name = template_name.trim();
  if (name.isEmpty()) return false;
  session_io::SaveOptions opts;
  opts.display_name = name;
  opts.created = juce::Time::getCurrentTime().toISO8601(true);
  opts.strip_performances = true;
  const bool ok =
      engine_.saveSessionTo(templatesRoot().getChildFile(name), opts);
  if (ok) rememberLastTemplate(name);  // bookkeeping (Q17: no auto-load)
  return ok;
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

std::vector<ProjectManager::Info> ProjectManager::listRecents(int max) const {
  auto all = listBundles(projectsRoot());
  // IDs are date-serial, so lexicographic descending = newest first.
  std::sort(all.begin(), all.end(),
            [](const Info& a, const Info& b) { return a.id > b.id; });
  if ((int)all.size() > max) all.resize((size_t)max);
  return all;
}

}  // namespace celestrian
