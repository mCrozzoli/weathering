#!/bin/bash
# Build the CccRPC SuperCollider UGen (libcccrt) on macOS and install it into Extensions.
# CoFlo (complexity-controlled feedback gain) needs this UGen; without it the
# sound engine falls back to spectral flatness and says so in sound.log.
# Run in Terminal:   bash tools/build_cccrpc.sh   (once per machine; needs Xcode command line tools and cmake)
set -e

SRC="$HOME/src"
EXT="$HOME/Library/Application Support/SuperCollider/Extensions"
# SuperCollider source tag — should match the SC.app you run (check Help > About). 3.13.0 is the current stable.
SC_TAG="${SC_TAG:-Version-3.13.0}"

# --- prerequisites -------------------------------------------------------------
xcode-select -p >/dev/null 2>&1 || { echo "Installing Xcode command line tools — rerun this script when done."; xcode-select --install; exit 1; }
command -v cmake >/dev/null 2>&1 || { echo "cmake missing. Install with:  brew install cmake"; exit 1; }
command -v git   >/dev/null 2>&1 || { echo "git missing (comes with Xcode CLT)"; exit 1; }

mkdir -p "$SRC" && cd "$SRC"

# --- sources -------------------------------------------------------------------
[ -d libcccrt ]     || git clone --depth 1 https://github.com/chriskiefer/libcccrt.git
[ -d supercollider ] || git clone --depth 1 --branch "$SC_TAG" https://github.com/supercollider/supercollider.git

# --- build ----------------------------------------------------------------------
cd libcccrt/plugins/supercollider
rm -rf build && mkdir build && cd build
cmake -DSC_PATH="$SRC/supercollider" \
      -DCMAKE_BUILD_TYPE=Release \
      -DSUPERNOVA=OFF \
      -DCMAKE_INSTALL_PREFIX="$PWD/install" ..
cmake --build . --config Release --target install

# --- install ----------------------------------------------------------------------
mkdir -p "$EXT"
rm -rf "$EXT/Ccc"
cp -R install/Ccc "$EXT/Ccc"

echo
echo "Installed to: $EXT/Ccc"
ls -R "$EXT/Ccc"
echo
echo "Now in SuperCollider: Language > Recompile Class Library, then test:"
echo '   { CccRPC.ar(SoundIn.ar(0), 8, 4, 0.5, 3, 300, 0.5).poll; 0 }.play'
