#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <map>
#include <memory>
#include <utility>

#include "dsp/vst3_slot.h"

namespace celestrian {

/**
 * Floating native windows for VST3 plugin editors (docs/vst3.md §5).
 *
 * One DocumentWindow per open slot, keyed by slot uuid. A window owns
 * its EDITOR and a SHARE of the slot: the plugin instance the editor
 * shows cannot be destroyed under it, whatever the chains and undo
 * entries that also hold the slot do (an undone add, a deleted track,
 * an evicted undo entry). Closing a window never touches the plugin's
 * processing; it releases the share, and the instance goes with the
 * last holder. Plugins without an editor get JUCE's
 * GenericAudioProcessorEditor in the same window — the web UI grows no
 * generic parameter panel. MESSAGE THREAD only.
 *
 * The bridge's removeChainSlot handler calls closeFor() first: an
 * editor is not left on screen for a slot the user just removed.
 */
class PluginEditorWindows {
 public:
  /** Opens (or refocuses) the editor window for `slot`'s plugin. No-op
   * for a null slot or one with no instance (a placeholder). */
  void open(std::shared_ptr<dsp::Vst3Slot> slot) {
    if (slot == nullptr || slot->instance() == nullptr) return;
    const juce::String slot_uuid = slot->slotUuid();
    if (auto it = windows_.find(slot_uuid); it != windows_.end()) {
      it->second->toFront(true);
      return;
    }
    juce::AudioPluginInstance& instance = *slot->instance();
    juce::AudioProcessorEditor* editor = instance.createEditorIfNeeded();
    if (editor == nullptr)
      editor = new juce::GenericAudioProcessorEditor(instance);
    auto window =
        std::make_unique<Window>(instance.getName(), *this, std::move(slot));
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
           std::shared_ptr<dsp::Vst3Slot> slot)
        : juce::DocumentWindow(
              title, juce::Colours::darkgrey,
              juce::DocumentWindow::closeButton |
                  juce::DocumentWindow::minimiseButton),
          owner_(owner),
          slot_(std::move(slot)) {
      setUsingNativeTitleBar(true);
      setResizable(true, false);
      centreWithSize(400, 300);  // the editor resizes us on attach
    }
    ~Window() override {
      // The editor goes BEFORE the share of its instance: members are
      // destroyed ahead of the base class that owns the content.
      clearContentComponent();
    }
    void closeButtonPressed() override {
      // Deleting the window deletes the editor (content-owned) and
      // releases the share; the instance lives on in its slot's other
      // holders. The key is copied: the slot may go with this window.
      const juce::String slot_uuid = slot_->slotUuid();
      owner_.closeFor(slot_uuid);
    }

   private:
    PluginEditorWindows& owner_;
    std::shared_ptr<dsp::Vst3Slot> slot_;
  };

  std::map<juce::String, std::unique_ptr<Window>> windows_;
};

}  // namespace celestrian
