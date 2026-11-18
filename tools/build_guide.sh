#!/bin/bash
# docs/guide/guide.html → docs/GUIDE.pdf (Chrome, headless). Screenshots in
# docs/guide/img/ come from the demo (see the guide's figures).
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE=$(mktemp -d); trap 'rm -rf "$PROFILE"' EXIT
"$CHROME" --headless=new --disable-gpu --user-data-dir="$PROFILE" --no-pdf-header-footer \
  --print-to-pdf="$PWD/docs/GUIDE.pdf" "file://$PWD/docs/guide/guide.html" 2>/dev/null
echo "docs/GUIDE.pdf"
