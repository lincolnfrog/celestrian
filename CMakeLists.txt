cmake_minimum_required(VERSION 3.22)

project(Celestrian VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Download CPM.cmake
include(cmake/CPM.cmake)

# Add JUCE
CPMAddPackage(
    NAME JUCE
    GITHUB_REPOSITORY juce-framework/JUCE
    GIT_TAG 8.0.4 # Use latest stable JUCE 8
    OPTIONS
        "JUCE_ENABLE_REPAINT_DEBUGGING OFF"
        "JUCE_BUILD_EXAMPLES OFF"
        "JUCE_BUILD_EXTRAS OFF"
)

if (JUCE_ADDED)
    message(STATUS "JUCE added successfully")
else()
    message(FATAL_ERROR "Failed to add JUCE")
endif()

# --- ASIO (Windows) ---------------------------------------------------
# On Windows the WDM/WASAPI driver of a multi-channel interface presents
# each pair as its OWN stereo endpoint ("MOTU Analog 1-2", "Analog 3-4",
# …), and Windows opens one endpoint at a time — so WASAPI caps you at 2
# simultaneous inputs no matter which device you select. ASIO is the only
# driver type that exposes all channels of the interface at once.
#
# Steinberg dual-licensed the ASIO SDK: the proprietary Steinberg ASIO
# License, OR GPLv3 (see LICENSE.txt in the SDK, (c) 2025 Steinberg Media
# Technologies GmbH). We take the GPLv3 option — GPLv3 §13 and AGPLv3 §13
# grant mutual permission to combine, so an ASIO-enabled Celestrian binary
# is distributable under this project's AGPLv3.
#
# JUCE compiles exactly one SDK header, <iasiodrv.h>, whose include closure
# is {iasiodrv.h, asiosys.h, asio.h} — all three carry the Steinberg dual
# license. The SDK's Microsoft-copyright driver-side files (common/combase.*)
# are never compiled, so they impose nothing on this build.
#
# Source: pinned to an immutable commit of a public mirror, so a force-push
# or a deleted repo cannot silently change what we build. To use Steinberg's
# official zip (https://www.steinberg.net/asiosdk) instead, configure with
#   -DCELESTRIAN_ASIO_SDK_DIR=<path to the unzipped SDK>
# Without either, the app still builds — you just get WASAPI's stereo pairs.
set(CELESTRIAN_ASIO_INCLUDE_DIR "" CACHE INTERNAL "")
if (WIN32)
    if (DEFINED CELESTRIAN_ASIO_SDK_DIR)
        # Accept either the SDK root or the common/ dir itself.
        find_path(CELESTRIAN_ASIO_INCLUDE_DIR
            NAMES iasiodrv.h
            PATHS "${CELESTRIAN_ASIO_SDK_DIR}"
            PATH_SUFFIXES common
            NO_DEFAULT_PATH)
        if (NOT CELESTRIAN_ASIO_INCLUDE_DIR)
            message(FATAL_ERROR
                "CELESTRIAN_ASIO_SDK_DIR=${CELESTRIAN_ASIO_SDK_DIR} but no "
                "iasiodrv.h under it (expected <dir>/common/iasiodrv.h).")
        endif()
    else()
        CPMAddPackage(
            NAME asiosdk
            GITHUB_REPOSITORY audiosdk/asio
            GIT_TAG 496a0765b8bb9c26f764f22f9a9712a937177db2 # main @ 2025-10-16
            DOWNLOAD_ONLY YES # headers only; the SDK ships no CMake project
        )
        if (asiosdk_ADDED AND EXISTS "${asiosdk_SOURCE_DIR}/common/iasiodrv.h")
            set(CELESTRIAN_ASIO_INCLUDE_DIR "${asiosdk_SOURCE_DIR}/common"
                CACHE INTERNAL "")
        endif()
    endif()

    if (CELESTRIAN_ASIO_INCLUDE_DIR)
        message(STATUS "ASIO enabled: ${CELESTRIAN_ASIO_INCLUDE_DIR}")
    else()
        message(WARNING
            "ASIO SDK unavailable — building WITHOUT ASIO. Multi-channel "
            "interfaces will only expose 2 inputs at a time.")
    endif()
endif()

# Applies the ASIO module flag + SDK include path to a target, if we have
# the SDK. JUCE module config is per-target, so every target that compiles
# juce_audio_devices needs this.
function(celestrian_enable_asio target)
    if (CELESTRIAN_ASIO_INCLUDE_DIR)
        target_compile_definitions(${target} PRIVATE JUCE_ASIO=1)
        target_include_directories(${target} PRIVATE ${CELESTRIAN_ASIO_INCLUDE_DIR})
    endif()
endfunction()

# Create the GUI app
juce_add_gui_app(Celestrian
    PRODUCT_NAME "Celestrian"
    VERSION "0.1.0"
    BUNDLE_ID "com.celestrian.daw"
    NEEDS_WEBVIEW2 TRUE # For Windows support
    MICROPHONE_PERMISSION_ENABLED TRUE
    CAMERA_PERMISSION_ENABLED TRUE
)

# Add source files
target_sources(Celestrian PRIVATE
    src/main.cc
    src/main_component.h
    src/main_component.cc
    src/audio_engine.h
    src/audio_engine.cc
    src/timing.h
    src/clip_node.cc
    src/take_storage.cc
    src/stack_node.cc
    src/session_io.cc
    src/project_manager.cc
    src/plugin_host_service.h
    src/plugin_host_service.cc
    src/plugin_scan_worker.h
    src/plugin_scan_worker.cc
    src/dsp/effects.cc
    src/dsp/fx_chain.cc
    src/dsp/vst3_slot.cc
)

# Link JUCE modules
target_link_libraries(Celestrian PRIVATE
    juce::juce_gui_extra
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_basics
    juce::juce_graphics
    juce::juce_gui_basics
    juce::juce_events
    juce::juce_core
)

# Enable WebView features + VST3 hosting (docs/vst3.md phase 1). The
# VST3 SDK headers ship inside JUCE under the SDK's GPLv3 option, which
# combines with this project's AGPLv3 exactly as the ASIO SDK does (see
# the ASIO comment above for the §13 reasoning) — no extra download.
target_compile_definitions(Celestrian PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2=1
    # NEEDS_WEBVIEW2 links WebView2LoaderStatic.lib, so JUCE must call
    # CreateCoreWebView2EnvironmentWithOptions directly. Without this it
    # tries LoadLibrary("WebView2Loader.dll"), fails (no such DLL beside
    # the exe), and silently falls back to the legacy IE backend — which
    # ignores the resource provider and shows "Can't reach this page".
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
)

celestrian_enable_asio(Celestrian)

# Copy UI files to the build directory (for development)
if (APPLE)
    # On macOS, the target directory is inside the .app bundle
    add_custom_command(TARGET Celestrian POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
        ${CMAKE_CURRENT_SOURCE_DIR}/ui
        $<TARGET_BUNDLE_DIR:Celestrian>/Contents/MacOS/ui
    )
else()
    add_custom_command(TARGET Celestrian POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
        ${CMAKE_CURRENT_SOURCE_DIR}/ui
        $<TARGET_FILE_DIR:Celestrian>/ui
    )
endif()

# --- Unit Tests ---
juce_add_console_app(CelestrianTests
    PRODUCT_NAME "CelestrianTests"
)

target_sources(CelestrianTests PRIVATE
    tests/test_runner.cc
    tests/timing_golden_tests.cc
    tests/qtime_tests.cc
    tests/monotonic_clock_tests.cc
    tests/seek_tests.cc
    tests/latency_calibration_tests.cc
    tests/pre_record_tests.cc
    tests/clip_node_tests.cc
    tests/stack_node_tests.cc
    tests/quantum_propagation_tests.cc
    tests/stack_loop_tests.cc
    tests/regression_tests.cc
    tests/audio_engine_tests.cc
    tests/undo_tests.cc
    tests/engine_bridge_tests.cc
    tests/qtime_lock_tests.cc
    tests/graph_snapshot_tests.cc
    tests/render_purity_tests.cc
    tests/project_manager_tests.cc
    tests/take_capacity_tests.cc
    tests/time_map_record_tests.cc
    tests/session_io_tests.cc
    tests/session_negative_tests.cc
    tests/project_lifecycle_tests.cc
    tests/repro_first_clip_bug.cc
    tests/ui_contract_tests.cc
    tests/effects_stereo_tests.cc
    tests/effects_tests.cc
    tests/stereo_pan_tests.cc
    tests/output_stage_tests.cc
    tests/one_shot_tests.cc
    tests/callback_edge_tests.cc
    tests/group_arm_tests.cc
    tests/take_undo_tests.cc
    tests/content_frame_tests.cc
    tests/audit_regression_tests.cc
    tests/solo_tests.cc
    tests/track_template_tests.cc
    tests/plugin_host_tests.cc
    tests/vst3_slot_tests.cc
    tests/plugin_host_integration_tests.cc
    tests/plugin_scan_crash_tests.cc
    tests/midi_tests.cc
    tests/midi_record_tests.cc
    tests/sequencer_tests.cc
    src/clip_node.cc
    src/take_storage.cc
    src/stack_node.cc
    src/audio_engine.cc
    src/session_io.cc
    src/project_manager.cc
    src/plugin_host_service.cc
    src/plugin_scan_worker.cc
    src/dsp/effects.cc
    src/dsp/fx_chain.cc
    src/dsp/vst3_slot.cc
)

target_link_libraries(CelestrianTests PRIVATE
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_audio_utils
    juce::juce_gui_basics
    juce::juce_core
)

# The test binary never opens a WebView or fetches URLs; juce_audio_utils
# drags in juce_gui_extra, whose browser code needs gtk/webkit headers (and
# juce_core's networking needs libcurl) on Linux. Disabling both keeps the
# console tests buildable on headless machines.
target_compile_definitions(CelestrianTests PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
)

celestrian_enable_asio(CelestrianTests)

# --- In-repo test VST3 plugins (docs/vst3.md phase 3 + §4) -------------
# Two deterministic real-binary validation targets for the hosting path,
# neither of which is ever shipped:
#   * "Celestrian Test Gain" (test_plugin/test_gain_plugin.cc): the
#     well-behaved one. tests/plugin_host_integration_tests.cc scans,
#     instantiates, and processes the ACTUAL built .vst3 — the
#     real-binary twin of the in-tree stub.
#   * "Celestrian Test Crash" (test_plugin/test_crash_plugin.cc): the
#     BAD one — it takes an invalid memory access the instant a host
#     probes it. tests/plugin_scan_crash_tests.cc scans it from a child
#     process to prove the dead-man's-pedal recovery: the scanning
#     process dies, the relaunch blacklists the culprit, and the scan
#     then completes with the gain plugin found.
# OFF for plain app builds if you want the shortest compile: they only
# exist for validation.
option(CELESTRIAN_BUILD_TEST_PLUGIN
    "Build the in-repo test VST3s used by hosting validation" ON)

# celestrian_add_test_plugin(<target> <product name> <bundle id>
#                            <4-char plugin code> <source> <test define>
#                            <auto manifest TRUE|FALSE>)
# Builds one VST3 test bundle, makes CelestrianTests depend on it, and
# tells the test binary where the plugin binary landed (tests walk up
# from there to the .vst3 bundle root). The manifest flag matters: a
# bundle with a moduleinfo.json is described from that file and NEVER
# loaded by a JUCE 8 scan (the host's fast path), so the crash plugin
# must go without one — both so the scan actually probes it and because
# the manifest generator itself would load it and die.
function(celestrian_add_test_plugin target product bundle_id code source define auto_manifest)
    juce_add_plugin(${target}
        VST3_AUTO_MANIFEST ${auto_manifest}
        PRODUCT_NAME "${product}"
        COMPANY_NAME "Celestrian"
        BUNDLE_ID "${bundle_id}"
        PLUGIN_MANUFACTURER_CODE Cele
        PLUGIN_CODE ${code}
        FORMATS VST3
        IS_SYNTH FALSE
        NEEDS_MIDI_INPUT FALSE
        NEEDS_MIDI_OUTPUT FALSE
        COPY_PLUGIN_AFTER_BUILD FALSE
    )
    target_sources(${target} PRIVATE ${source})
    target_link_libraries(${target} PRIVATE
        juce::juce_audio_processors
        juce::juce_audio_utils
    )
    target_compile_definitions(${target} PUBLIC
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_VST3_CAN_REPLACE_VST2=0
    )
    add_dependencies(CelestrianTests ${target}_VST3)
    target_compile_definitions(CelestrianTests PRIVATE
        ${define}="$<TARGET_FILE_DIR:${target}_VST3>"
    )
endfunction()

if (CELESTRIAN_BUILD_TEST_PLUGIN)
    celestrian_add_test_plugin(CelestrianTestGain "Celestrian Test Gain"
        com.celestrian.testgain Ctg1 test_plugin/test_gain_plugin.cc
        CELESTRIAN_TEST_GAIN_VST3_BINARY_DIR TRUE)
    celestrian_add_test_plugin(CelestrianTestCrash "Celestrian Test Crash"
        com.celestrian.testcrash Ctc1 test_plugin/test_crash_plugin.cc
        CELESTRIAN_TEST_CRASH_VST3_BINARY_DIR FALSE)
endif()
