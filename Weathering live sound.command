#!/bin/bash
# Weathering with the real sculpture's sound: four piezos in, four exciters
# out, through the sound card chosen in System Settings → Sound (input and
# output). Otherwise the same as Weathering.command.
cd "$(dirname "$0")"
exec ./Weathering.command --sound-live "$@"
