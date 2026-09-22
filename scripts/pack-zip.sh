#!/usr/bin/env bash
# Package the extension into dist/novel-to-epub-<version>.zip for sharing.
# Only ships the files the browser needs — no git/dev/dist cruft.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
out="dist/novel-to-epub-${version}.zip"

mkdir -p dist
rm -f "$out"

zip -r -X "$out" \
  manifest.json background.js popup.html popup.css popup.js epub.js \
  adapters icons \
  -x '*/.DS_Store' >/dev/null

echo "Built $out"
unzip -Z1 "$out" | sed 's/^/  /'
