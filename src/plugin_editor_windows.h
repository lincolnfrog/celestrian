#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <map>
#include <memory>

namespace celestrian {

/**
 * Floating native windows for VST3 plugin editors (docs/vst3.md §5).
 *
 * One DocumentWindow per open slot, keyed by slot uuid; the window owns
 * the EDITOR only, never the instance (closing a window never touches
 * the plugin's processing). Plugins without an editor get JUCE's
 * GenericAudioProcessorEditor in the same window — the web UI grows no
 * generic parameter panel (owner ruling 2026-08-15). MESSAGE THREAD
 * only. Close-before-removal discipline: the bridge's removeChainSlot
 * handler calls closeFor() FIRST, so an editor never outlives its
 * slot's place in the chain (the undo entry keeps the instance alive
 * regardless — this is about not showing an editor for a slot the user
 * just deleted).
 */
class PluginEditorWindows {
 public:
  /** Opens (or refocuses) the editor window for `instance`. */
  void open(const juce::String& slot_uuid,
            juce::AudioPluginInstance& instance) {
    if (auto it = windows_.find(slot_uuid); it != windows_.end()) {
      it->second->toFront(true);
      return;
    }
    juce::AudioProcessorEditor* editor = instance.createEditorIfNeeded();
    if (editor == nullptr)
      editor = new juce::GenericAudioProcessorEditor(instance);
    auto window = std::make_unique<Window>(instance.getName(), *this,
                                           slot_uuid);
    window->setContentOwned(editor, /*resizeToFitWhenContentChangesSize=*/true);
    window->setVisible(true);
    windows_[slot_uuid] = std::move(window);
  }

  /** Closes the slot's window if open (no-op otherwise). */
  void closeFor(const juce::String& slot_uuid) { windows_.erase(slot_uuid); }

  void closeAll() { windows_.clear(); }

 private:
  class Window : public juce::DocumentWindow {
   public:
    Window(const juce::String& title, PluginEditorWindows& owner,
           juce::String slot_uuid)
        : juce::DocumentWindow(
              title, juce::Colours::darkgrey,
              juce::DocumentWindow::closeButton |
                  juce::DocumentWindow::minimiseButton),
          owner_(owner),
          slot_uuid_(std::move(slot_uuid)) {
      setUsingNativeTitleBar(true);
      setResizable(true, false);
      centreWithSize(400, 300);  // the editor resizes us on attach
    }
    void closeButtonPressed() override {
      // Deleting the window deletes the EDITOR (content-owned); the
      // plugin instance lives on in its slot.
      owner_.closeFor(slot_uuid_);
    }

   private:
    PluginEditorWindows& owner_;
    juce::String slot_uuid_;
  };

  std::map<juce::String, std::unique_ptr<Window>> windows_;
};

}  // namespace celestrian
