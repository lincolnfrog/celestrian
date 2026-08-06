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
    src/stack_node.cc
    src/session_io.cc
    src/project_manager.cc
    src/dsp/effects.cc
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

# Enable WebView features
target_compile_definitions(Celestrian PRIVATE
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
    tests/latency_calibration_tests.cc
    tests/pre_record_tests.cc
    tests/clip_node_tests.cc
    tests/stack_node_tests.cc
    tests/quantum_propagation_tests.cc
    tests/stack_loop_tests.cc
    tests/regression_tests.cc
    tests/audio_engine_tests.cc
    tests/undo_tests.cc
    tests/qtime_lock_tests.cc
    tests/graph_snapshot_tests.cc
    tests/render_purity_tests.cc
    tests/project_manager_tests.cc
    tests/take_capacity_tests.cc
    tests/time_map_record_tests.cc
    tests/session_io_tests.cc
    tests/repro_first_clip_bug.cc
    tests/ui_contract_tests.cc
    tests/effects_tests.cc
    tests/stereo_pan_tests.cc
    src/clip_node.cc
    src/stack_node.cc
    src/audio_engine.cc
    src/session_io.cc
    src/project_manager.cc
    src/dsp/effects.cc
)

target_link_libraries(CelestrianTests PRIVATE
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_utils
    juce::juce_gui_basics
    juce::juce_core
)

celestrian_enable_asio(CelestrianTests)
