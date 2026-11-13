#!/bin/bash
# Weathering — double-click to start the installation.
#
# Opens the page in your browser and connects to the hub on USB. Readings
# are saved in ~/.weathering/shows/ as they arrive, so closing the page or a
# crash loses nothing: double-click again and the show carries on.
# The only thing it installs is pyserial, into .venv next to this file
# (about 15 seconds, the first time only).

cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
VENV_PY=".venv/bin/python"

if [ ! -x "$VENV_PY" ] || ! "$VENV_PY" -c "import serial" 2>/dev/null; then
  echo "[Weathering] one-time setup…"
  if ! command -v "$PY" >/dev/null 2>&1; then
    echo "No python3 found. Install it from https://www.python.org/downloads/ and try again."
    read -r -p "Press Enter to close." _
    exit 1
  fi
  rm -rf .venv
  "$PY" -m venv .venv && "$VENV_PY" -m pip install --quiet --upgrade pip && "$VENV_PY" -m pip install --quiet pyserial || {
    echo "Setup failed (are you online?)."
    read -r -p "Press Enter to close." _
    exit 1
  }
  echo "[Weathering] ready."
fi

exec "$VENV_PY" -m app "$@"
