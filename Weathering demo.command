#!/bin/bash
# Weathering without hardware: a pretend hub, sensor box and sculpture,
# running 720× faster than real time (12 hours a minute). Kept in its own
# show called "demo", so it never mixes with a real installation.
cd "$(dirname "$0")"
exec ./Weathering.command --fake 720 --show demo "$@"
