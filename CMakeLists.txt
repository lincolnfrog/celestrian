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
