#include "clip_node.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include "box_node.h"

namespace celestrian {

ClipNode::ClipNode(juce::String node_name, double source_sample_rate)
    : AudioNode(std::move(node_name)), sample_rate(source_sample_rate) {
  // Initial size of 60 seconds
  buffer.setSize(1, (int)(sample_rate * 60));
  buffer.clear();
}

juce::var ClipNode::getMetadata() const {
  auto base = AudioNode::getMetadata();
  auto *obj = base.getDynamicObject();
  obj->setProperty("sampleRate", sample_rate);
  obj->setProperty("inputChannel", preferred_input_channel);
  obj->setProperty("isPendingStart", (bool)is_pending_start.load());
  obj->setProperty("isAwaitingStop", (bool)is_awaiting_stop.load());
  obj->setProperty("isPlaying", (bool)is_playing.load());

  // Debug: Log awaiting stop state when true
  if (is_awaiting_stop.load()) {
    juce::Logger::writeToLog(
        "  [State] isAwaitingStop=TRUE, awaiting_stop_at=" +
        juce::String(awaiting_stop_at.load()) +
        ", current write_position=" + juce::String(write_position.load()));
  }

  int64_t Q = getEffectiveQuantum();
  if (Q > 0 && is_node_recording.load()) {
    obj->setProperty("recordingStartPhase",
                     (double)(trigger_master_position.load() % Q));
  }

  return base;
}

int64_t ClipNode::getEffectiveQuantum() const {
  if (parent) return parent->getEffectiveQuantum();
  return 0;
}

void ClipNode::process(const float *const *input_channels,
                       float *const *output_channels, int num_input_channels,
                       int num_output_channels, const ProcessContext &context) {
  // Handle PLL Start Anchor
  if (is_pending_start.load()) {
    int64_t Q = getEffectiveQuantum();
    bool should_start = true;

    if (Q > 0) {
      int64_t phase = context.master_pos % Q;
      int64_t dist_to_next = Q - phase;
      int64_t tolerance = (int64_t)(Q * 0.25);  // 25% Anticipatory Start

      if (dist_to_next < tolerance) {
        should_start = false;  // Wait for the next boundary
      }
    }

    if (should_start) {
      // Latency Compensation:
      // The user played in response to what they HEARD (delayed by
      // output_latency). Their performance reached the software delayed by
      // input_latency. Total compensation = input + output latency.
      int64_t compensated_pos =
          context.master_pos - (context.input_latency + context.output_latency);
      if (compensated_pos < 0) compensated_pos = 0;

      trigger_master_position.store(compensated_pos);
      // Note: anchor_phase will be set AFTER we calculate effective_pos (below)

      // Calculate visual X position based on context loop
      // context_loop = max(longest_existing_sibling_duration, Q)
      int64_t Q = getEffectiveQuantum();
      int64_t context_loop = Q > 0 ? Q : 1;

      // Find longest sibling clip (the context loop)
      if (parent != nullptr) {
        auto *box = dynamic_cast<BoxNode *>(parent);
        if (box != nullptr) {
          for (int i = 0; i < box->getNumChildren(); ++i) {
            auto *sibling = box->getChild(i);
            if (sibling != this && !sibling->is_node_recording.load()) {
              int64_t sib_dur = sibling->duration_samples.load();
              if (sib_dur > context_loop) {
                context_loop = sib_dur;
              }
            }
          }
        }
      }

      // base_width = 200px (1 quantum), base_x = fixed starting position
      double base_width = 200.0;
      double base_x = 0.0;  // Fixed base - slot determines position from 0

      // Calculate EFFECTIVE position = what the user SAW (playhead position)
      // This is LOOP-RELATIVE, not global time. The user's intent is:
      // "I pressed record when the playhead was HERE in the loop"
      int64_t context_launch_point = 0;
      if (parent != nullptr) {
        auto *box = dynamic_cast<BoxNode *>(parent);
        if (box != nullptr) {
          for (int i = 0; i < box->getNumChildren(); ++i) {
            auto *sibling = box->getChild(i);
            if (sibling != this && !sibling->is_node_recording.load()) {
              int64_t sib_dur = sibling->duration_samples.load();
              if (sib_dur == context_loop) {
                context_launch_point = sibling->launch_point_samples.load();
                break;
              }
            }
          }
        }
      }

      // Calculate offset (same formula as playback uses)
      int64_t playback_offset =
          (context_loop - (context_launch_point % context_loop)) % context_loop;

      // Effective position = LOOP-RELATIVE position where user pressed record
      int64_t effective_pos =
          (compensated_pos + playback_offset) % context_loop;

      // ALWAYS SNAP to next Q boundary
      // Key insight:
      // - Single-clip: use compensated_pos (extending timeline)
      // - Multi-clip: use effective_pos (visual position in loop)
      if (Q > 0) {
        bool singleClipContext = (context_loop == Q);

        int64_t next_q_master;
        if (singleClipContext) {
          // Single clip context: extend timeline using absolute position
          int64_t current_q_index = compensated_pos / Q;
          next_q_master = (current_q_index + 1) * Q;
          if (compensated_pos % Q == 0) {
            next_q_master = compensated_pos;  // Already at boundary
          }
        } else {
          // Multi-clip context: use visual position (what user sees)
          int64_t visual_q_index = effective_pos / Q;
          int64_t next_visual_q = (visual_q_index + 1) * Q;
          if (effective_pos % Q == 0) {
            next_visual_q = effective_pos;
          }
          // Convert visual next_q back to master_pos terms
          int64_t loop_base = (compensated_pos / context_loop) * context_loop;
          int64_t offset_in_loop =
              (next_visual_q - playback_offset + context_loop) % context_loop;
          // Handle the case where next_visual_q wraps to 0 (e.g., 4Q % 4Q = 0)
          // In this case, we need to go to the next context loop
          if (offset_in_loop == 0 && next_visual_q > 0) {
            offset_in_loop = context_loop;  // Next cycle
          }
          next_q_master = loop_base + offset_in_loop;
          juce::Logger::writeToLog(
              "  DEBUG: eff_pos=" + juce::String(effective_pos) +
              ", vis_q_idx=" + juce::String(visual_q_index) +
              ", next_vis_q=" + juce::String(next_visual_q) +
              ", pb_offset=" + juce::String(playback_offset) +
              ", next_q=" + juce::String(next_q_master));
        }

        // Calculate what the effective_pos will be at that Q boundary
        int64_t playback_offset2 =
            (context_loop - (context_launch_point % context_loop)) %
            context_loop;
        int64_t future_effective_pos =
            (next_q_master + playback_offset2) % context_loop;

        // anchor_phase_samples = position within Q (for audio alignment)
        anchor_phase_samples.store(future_effective_pos % Q);
        // Store full effective_pos for unified launch_point calculation
        recording_start_phase.store(future_effective_pos);
        juce::Logger::writeToLog(
            "  RECORDING_START: next_q=" + juce::String(next_q_master) +
            ", pb_offset2=" + juce::String(playback_offset2) +
            ", context=" + juce::String(context_loop) +
            ", future_eff_pos=" + juce::String(future_effective_pos) +
            ", start_phase_stored=" + juce::String(future_effective_pos));

        // slot = which Q slot visually
        // Key insight: slot is VISUAL position, not audio phase position
        // - future_effective_pos includes playback_offset for audio alignment
        // - slot should be based on next_q_master (visual playhead position)
        int64_t slot;

        if (singleClipContext && next_q_master > context_loop) {
          // Single clip extending beyond Q - use absolute next_q
          slot = next_q_master / Q;
        } else {
          // Multi-clip OR within context - use visual position (wrapped)
          slot = (next_q_master % context_loop) / Q;
        }
        x_pos.store(base_x + slot * base_width);

        juce::Logger::writeToLog(
            "  → Waiting for Q: master_pos=" + juce::String(compensated_pos) +
            ", next_q=" + juce::String(next_q_master) +
            ", context=" + juce::String(context_loop) +
            ", eff_pos=" + juce::String(future_effective_pos) + ", slot=" +
            juce::String(slot) + ", x_pos=" + juce::String(x_pos.load()));

        // If already at boundary, start immediately
        if (compensated_pos >= next_q_master ||
            next_q_master - compensated_pos < 512) {
          is_pending_start.store(false);
          is_recording.store(true);
          is_node_recording.store(true);
          trigger_master_position.store(next_q_master);  // Capture start time
          write_position.store(0);
          live_duration_samples.store(0);
          juce::Logger::writeToLog(
              "ClipNode: Recording Started (at Q boundary)");
        } else {
          // Wait for the Q boundary
          awaiting_start_at.store(next_q_master);
          juce::Logger::writeToLog("ClipNode: Awaiting start at " +
                                   juce::String(next_q_master));
        }
      } else {
        // No Q established yet (first clip) - start immediately at anchor=0
        anchor_phase_samples.store(0);
        recording_start_phase.store(0);  // First clip starts at phase 0
        x_pos.store(base_x);
        is_pending_start.store(false);
        is_recording.store(true);
        is_node_recording.store(true);
        trigger_master_position.store(
            compensated_pos);  // Capture start time (immediate)
        write_position.store(0);
        live_duration_samples.store(0);
        juce::Logger::writeToLog("ClipNode: Recording Started at master_pos=" +
                                 juce::String(compensated_pos) +
                                 " (anchor=0, first clip)");
      }
    }

    // Check if we're waiting to start at a Q boundary
    if (is_pending_start.load() && awaiting_start_at.load() > 0) {
      int64_t target = awaiting_start_at.load();
      int64_t start_p = context.master_pos;
      int64_t end_p = context.master_pos + context.num_samples;

      if (start_p < target && end_p >= target) {
        is_pending_start.store(false);
        awaiting_start_at.store(0);
        is_recording.store(true);
        is_node_recording.store(true);
        trigger_master_position.store(target);  // Capture start time (delayed)
        write_position.store(0);
        live_duration_samples.store(0);
        juce::Logger::writeToLog(
            "ClipNode: Recording Started (crossed Q boundary at " +
            juce::String(target) + ")");
      }
    }
  }

  // Handle Recording
  if (is_recording.load()) {
    if (context.is_recording && input_channels != nullptr &&
        num_input_channels > 0) {
      const float *in = input_channels[std::min(preferred_input_channel,
                                                num_input_channels - 1)];
      int samples_to_write = std::min(
          context.num_samples, buffer.getNumSamples() - write_position.load());

      if (samples_to_write > 0) {
        buffer.copyFrom(0, write_position.load(), in, samples_to_write);

        // Peak tracking
        float blockPeak = 0.0f;
        for (int ch = 0; ch < num_input_channels; ++ch) {
          if (input_channels[ch] != nullptr) {
            for (int i = 0; i < samples_to_write; ++i) {
              blockPeak = std::max(blockPeak, std::abs(input_channels[ch][i]));
            }
          }
        }
        last_block_peak.store(blockPeak);

        if (blockPeak > current_max_peak.load()) {
          current_max_peak.store(blockPeak);
        }

        int64_t start_p = write_position.load();
        write_position.fetch_add(samples_to_write);
        int64_t end_p = write_position.load();
        live_duration_samples.store(end_p);  // Live update for UI visibility

        if (is_awaiting_stop.load()) {
          int64_t target = awaiting_stop_at.load();
          if (start_p < target && end_p >= target) {
            commit_master_pos.store(context.master_pos);
            commitRecording(target);
            is_awaiting_stop.store(false);
            return;
          }
        }
        // Note: if samples_to_write <= 0, buffer is full - just stop writing
        // Do NOT call commitRecording here; wait for explicit stop
      }
    }
  }

  // Handle Playback
  if (context.is_playing && is_playing) {
    int64_t start = loop_start_samples.load();
    int64_t end = loop_end_samples.load();
    int64_t dur = end - start;

    if (dur > 0) {
      bool isSilenced = is_muted.load() || (!context.solo_node_uuid.isEmpty());
      if (isSilenced && !is_muted.load()) {
        // Check if we or any ancestor is soloed
        celestrian::AudioNode *curr = this;
        while (curr != nullptr) {
          if (curr->getUuid() == context.solo_node_uuid) {
            isSilenced = false;
            break;
          }
          curr = curr->getParent();
        }
      }

      // Audio Memory Principle: playback starts from launch_point to maintain
      // alignment with the audio context during recording.
      // launch_point is calculated at commit so that effective_pos starts at 0
      int64_t launch = launch_point_samples.load();
      int64_t offset = launch;  // Use launch directly - ensures loop continuity

      // DEBUG: Log first playback frame for this clip only
      if (!debug_playback_logged_) {
        debug_playback_logged_ = true;
        juce::Logger::writeToLog(
            "PLAYBACK DEBUG [" + getName() +
            "]: master=" + juce::String(context.master_pos) +
            ", launch=" + juce::String(launch) + ", dur=" + juce::String(dur) +
            ", effective_pos=" +
            juce::String((context.master_pos + offset) % dur));
      }

      for (int i = 0; i < context.num_samples; ++i) {
        // Calculate effective position with launch offset
        int64_t current_master_pos = context.master_pos + i;
        int64_t effective_pos = (current_master_pos + offset) % dur;
        int current_read_position =
            (int)((start + effective_pos) % buffer.getNumSamples());

        for (int ch = 0; ch < num_output_channels; ++ch) {
          if (output_channels[ch] != nullptr && !isSilenced) {
            output_channels[ch][i] +=
                buffer.getReadPointer(0)[current_read_position];
          }
        }
      }

      // Update playhead position for UI
      // Show position within THIS clip as 0..1
      int64_t effective_pos = (context.master_pos + offset) % dur;
      if (dur > 0)
        playhead_pos.store((double)effective_pos / (double)dur);
      else
        playhead_pos.store(0.0);
    } else {
      playhead_pos.store(0.0);
    }
  }
}

void ClipNode::startRecording() {
  buffer.clear();
  write_position.store(0);
  read_position.store(0);
  current_max_peak.store(0.0f);

  is_pending_start.store(true);
  is_recording.store(false);
  is_node_recording.store(true);

  duration_samples.store(0);
  is_playing.store(false);
}

void ClipNode::stopRecording() {
  if (is_node_recording.load()) {
    int64_t L = (int64_t)write_position.load();
    int64_t Q = getEffectiveQuantum();

    if (Q > 0) {
      // ALWAYS wait for the next clean quantum boundary
      // No tolerance check - recording always extends to next Q
      int64_t nextB = ((L / Q) + 1) * Q;

      // Also check subdivisions for short recordings (< Q/2)
      if (L < Q / 2) {
        for (int d : {2, 4, 8}) {
          int64_t sub = Q / d;
          if (sub > L && sub < nextB) nextB = sub;
        }
      }

      awaiting_stop_at.store(nextB);
      is_awaiting_stop.store(true);
      juce::Logger::writeToLog(
          "ClipNode: Waiting for next Q boundary B=" + juce::String(nextB) +
          " (current L=" + juce::String(L) + ")");
      return;
    }

    // For immediate stop (First Clip), assume commit pos equals duration
    // (since global transport resets to 0 at start of first clip)
    commit_master_pos.store(write_position.load());
    commitRecording();
  }
}

void ClipNode::commitRecording(int64_t final_duration) {
  if (is_node_recording.load()) {
    is_recording.store(false);
    is_pending_start.store(false);
    is_awaiting_stop.store(false);
    is_node_recording.store(false);

    int64_t L = (int64_t)write_position.load();
    int64_t Q = getEffectiveQuantum();
    int64_t duration = L;

    if (Q > 0 && final_duration <= 0) {
      // Hysteresis Snapping Logic
      const double HYSTERESIS_THRESHOLD = 0.15;  // 15% tolerance

      // Find the CLOSEST clean multiple of Q to L (either floor or ceiling)
      // No hard-coded limit - works for any quantum multiple
      int64_t floor_multiple = (L / Q) * Q;
      int64_t ceil_multiple = floor_multiple + Q;

      // Also consider subdivisions for short recordings
      std::vector<int64_t> candidates = {floor_multiple, ceil_multiple};
      for (int d : {2, 4, 8}) {
        int64_t sub = Q / d;
        if (sub > 0) candidates.push_back(sub);
      }

      int64_t best_B = -1;
      int64_t min_diff = std::numeric_limits<int64_t>::max();

      for (int64_t B : candidates) {
        if (B <= 0) continue;
        int64_t diff = std::abs(L - B);
        if (diff < min_diff) {
          min_diff = diff;
          best_B = B;
        }
      }

      if (best_B != -1 &&
          min_diff < (int64_t)(HYSTERESIS_THRESHOLD * (double)Q)) {
        duration = best_B;
        juce::Logger::writeToLog(
            "ClipNode: Late Snap to B=" + juce::String(best_B) +
            " (L=" + juce::String(L) + ")");
        loop_start_samples.store(0);
        loop_end_samples.store(duration);
      } else {
        // Outside tolerance: Keep raw duration but snap loop region to
        // previous clean multiple.
        int64_t loop_end = L;
        if (Q > 0) {
          loop_end = (L / Q) * Q;
          if (loop_end == 0)
            loop_end = Q / 2;  // Default subdivision if too short
        }

        loop_start_samples.store(0);
        loop_end_samples.store(loop_end);

        juce::Logger::writeToLog(
            "ClipNode: Instant Stop at L=" + juce::String(L) +
            " (Outside tolerance). " + "Loop Region set to " +
            juce::String(loop_end));
      }
    } else if (final_duration > 0) {
      duration = final_duration;
      juce::Logger::writeToLog("ClipNode: Anticipatory Snap to B=" +
                               juce::String(duration));
      loop_start_samples.store(0);
      loop_end_samples.store(duration);
    } else {
      // No quantum or fallback
      loop_end_samples.store(duration);
    }

    duration_samples.store(duration);  // CRITICAL: Store final duration so UI
                                       // knows clip is valid!

    // 1. Determine Context Loop (siblings) to find preferred Visual Position
    // note: Q is already defined at top of function
    int64_t context_loop = (Q > 0) ? Q : 1;

    // Find longest sibling to define the context grid
    if (parent != nullptr) {
      if (auto *box = dynamic_cast<BoxNode *>(parent)) {
        for (int i = 0; i < box->getNumChildren(); ++i) {
          auto *sibling = box->getChild(i);
          // Use generic AudioNode interface (NO CASTING)
          if (sibling != this && !sibling->isRecording()) {
            int64_t sd = sibling->getIntrinsicDuration();
            if (sd > context_loop) context_loop = sd;
          }
        }
      }
    }

    // 2. Calculate Preferred Visual Position (based on Context)
    // Example: Trigger=14Q. Context=1Q. Ideal X = 14%1 = 0Q.
    // Example: Trigger=2Q. Context=4Q. Ideal X = 2%4 = 2Q.
    int64_t trigger_pos = trigger_master_position.load();
    int64_t ideal_anchor =
        (context_loop > 0) ? (trigger_pos % context_loop) : 0;

    // 3. Calculate Audio Phase (based on LCM Context)
    // Per LCM model: anchor is ALWAYS relative to context_loop, not self
    // duration. With 1Q context, any trigger_pos % 1Q = 0. Clip MUST anchor
    // at 0Q.
    int64_t audio_anchor =
        (context_loop > 0) ? (trigger_pos % context_loop) : 0;

    // 4. Resolve Mismatch via Buffer Rotation
    // If Visual desires 0 but Audio is at 2, we must Rotate Buffer by -2
    // so that "Audio Start" moves to "Visual 2" (Middle).
    // Wait... If Visual is 0. Cursor at 2Q (Global).
    // Cursor matches Audio Phase (2Q).
    // So if we don't rotate, Cursor (at Middle) plays Audio (at Middle).
    // But Audio Middle IS Start of Recording.
    // So we hear Start.
    // So NO ROTATION needed if we trust the Global Cursor position?
    // BUT User wants "Clip 2 starts at 0Q".
    // If x=0. Cursor at 2Q.
    // User sees Cursor at Middle. Hears Start.
    // This is CORRECT operationally.
    // So we just need to enforce x_pos = ideal_anchor.

    // 4. Resolve Mismatch via Buffer Rotation
    // If Visual desires 0 but Audio is at 2, we must Rotate Buffer by -2
    // so that "Audio Start" moves to "Visual 2" (Middle).

    // Check if we need rotation
    // Mismatch exists if (ideal_anchor % duration) != (audio_anchor %
    // duration) Note: ideal_anchor is based on Context, audio_anchor on Self
    // Duration. We only rotate if the visual placement implies a different
    // START point within the loop.

    // For User Case: ideal=0. audio=2.
    // If x=0. Cursor at 2Q.
    // If we DON'T rotate: At 2Q Global, we read 2Q Local.
    // 2Q Local = Middle of buffer.
    // But we want to hear Start of buffer (Audio Phase Match).
    // So "Start of Buffer" must move to "2Q Local".
    // This is a rotation of +2Q (Right shift) or -2Q (Left shift)?
    // Index 2 should contain Old Index 0.
    // So New[2] = Old[0].

    bool rotated = false;

    // In User Case (x=0, master=2), the visual cursor is at 2.
    // The Audio Engine reads at index 2.
    // We want index 2 to contain the Start of Audio (Old Index 0).
    // So we need to SHIFT the buffer contents such that 0 moves to 2.
    // New[i] = Old[i - 2].
    // This is a RIGHT SHIFT by `audio_anchor`.

    int64_t final_anchor = audio_anchor;  // Initialize final_anchor

    if (audio_anchor != 0) {
      // Only rotate if we are forcing a visual override (x=0) that mismatches
      // actual phase If x was 2Q (ideal_anchor=2), then Global Cursor at 2Q
      // matches Local 0Q? No. If x=2Q. Cursor at 4Q?

      // Let's stick to the invariant:
      // "Perceptual Alignment".
      // We assume App renders Cursor at `(Master % Dur)`.
      // At Start Time, Master % Dur = 2.
      // So Cursor is at Index 2.
      // We MUST hear Start Audio at Index 2.
      // So Start Audio (Old 0) must move to Index 2.
      // Rotation = +2.

      int64_t rotation = audio_anchor;

      if (rotation > 0 && rotation < duration) {
        juce::AudioBuffer<float> temp;
        temp.makeCopyOf(buffer);

        // Rotate: New[i] = Old[i - rotation]
        // Part A: [0..rotation-1] comes from End of buffer
        // Part B: [rotation..end] comes from Start of buffer

        int64_t partA_len = rotation;
        int64_t partB_len = duration - rotation;

        // Copy Part B (Old Start) to New [rotation]
        buffer.copyFrom(0, rotation, temp.getReadPointer(0), partB_len);
        // Copy Part A (Old End) to New [0]
        buffer.copyFrom(0, 0, temp.getReadPointer(0, partB_len), partA_len);

        rotated = true;

        juce::Logger::writeToLog("ClipNode: Rotated buffer by " +
                                 juce::String(rotation) + " samples.");

        // Reset phases because we physically moved the audio
        final_anchor = 0;
      }
    }

    // Visual Position adheres to Context Grid (USER REQUEST)
    if (Q > 0) {
      // Quantize ideal anchor to Q
      int64_t offset_units = ideal_anchor / Q;
      x_pos.store(offset_units * 200.0);
    } else {
      x_pos.store(0.0);
    }

    // 5. Update Anchor/Launch Point to match AUDIO Reality
    // Anchor represents the phase offset of the content relative to Global 0
    anchor_phase_samples.store(final_anchor);

    // UNIFIED TIMING: Calculate launch_point from recording START phase
    // This ensures all clips recorded at the same position have the same
    // offset, keeping playheads synchronized regardless of when they commit.
    // Formula: when context_phase = recording_start_phase, clip plays at
    // position 0
    int64_t start_phase = recording_start_phase.load();
    int64_t launch_point =
        (duration > 0) ? (duration - (start_phase % duration)) % duration : 0;
    launch_point_samples.store(launch_point);

    juce::Logger::writeToLog(
        "ClipNode: Commit. Duration=" + juce::String(duration) +
        ", StartTime=" + juce::String(trigger_pos) +
        ", StartPhase=" + juce::String(start_phase) +
        ", LaunchPoint=" + juce::String(launch_point) +
        ", FinalAnchor=" + juce::String(final_anchor));

    is_playing.store(true);
  }
}

void ClipNode::startPlayback() {
  if (duration_samples.load() > 0) {
    read_position.store(0);
    is_playing.store(true);
  }
}

void ClipNode::stopPlayback() { is_playing.store(false); }

juce::var ClipNode::getWaveform(int num_peaks) const {
  juce::Array<juce::var> peaks;
  int total_samples = (int)duration_samples;
  if (total_samples <= 0) total_samples = write_position.load();

  if (total_samples <= 0) return peaks;

  int window_size = std::max(1, total_samples / num_peaks);
  const float *data = buffer.getReadPointer(0);

  for (int i = 0; i < num_peaks; ++i) {
    int start = i * window_size;
    int end = std::max(start + 1, std::min(start + window_size, total_samples));
    float peak = 0.0f;
    if (start < total_samples) {
      for (int s = start; s < end; ++s) {
        peak = std::max(peak, std::abs(data[s]));
      }
    }
    peaks.add(peak);
  }

  return peaks;
}

}  // namespace celestrian
