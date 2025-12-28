# Celestrian

An open-source Digital Audio Workstation (DAW) built with JUCE and modern web technologies.

## Getting Started

### Prerequisites

- CMake (3.22 or higher)
- A modern C++ compiler (supporting C++20)
- JUCE dependencies (automatically handled via CPM)

### Build Instructions

1. **Configure the project**:
   ```bash
   cmake -B build
   ```

2. **Build the application**:
   ```bash
   cmake --build build --parallel 8
   ```

3. **Run the application**:
   On macOS:
   ```bash
   open build/Celestrian_artefacts/Celestrian.app
   ```

## Development

- **Source Code**: `src/` (C++20, JUCE 8)
- **UI**: `ui/` (HTML/CSS/JS)
- **Design Docs**: `.agent/design_doc.md`
