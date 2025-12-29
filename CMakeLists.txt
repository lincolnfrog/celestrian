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
    src/clip_node.cc
    src/box_node.cc
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
)

# Copy UI files to the build directory (for development)
add_custom_command(TARGET Celestrian POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
    ${CMAKE_CURRENT_SOURCE_DIR}/ui
    $<TARGET_FILE_DIR:Celestrian>/ui
)

# --- Unit Tests ---
juce_add_console_app(CelestrianTests
    PRODUCT_NAME "CelestrianTests"
)

target_sources(CelestrianTests PRIVATE
    tests/test_runner.cc
    tests/clip_node_tests.cc
    tests/box_node_tests.cc
    src/clip_node.cc
    src/box_node.cc
)

target_link_libraries(CelestrianTests PRIVATE
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_utils
    juce::juce_gui_basics
    juce::juce_core
)
