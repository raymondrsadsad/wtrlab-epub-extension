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
  manifest.json background.js popup.html popup.css popup.js \
  epub.js epubread.js mergeview.js readerview.js selftest.js \
  webwidget.js webwidget.css \
  offscreen.html offscreen.js \
  adapters icons \
  -x '*/.DS_Store' >/dev/null

# Guardrail: every relative ES import must actually ship in the zip. This is the
# check that would have caught 1.13.0, where popup.js imported ./selftest.js but the
# packer never included it — the 404'd module aborted, leaving a dead popup. Reads the
# built zip directly so it verifies the real artifact, not the working tree.
python3 - "$out" <<'PY'
import sys, zipfile, re, posixpath
out = sys.argv[1]
zf = zipfile.ZipFile(out)
names = set(zf.namelist())
# match `from "./x"`, bare `import "./x"`, and dynamic `import("./x")` — relatives only
rx = re.compile(r'''(?:\bfrom|\bimport)\s*\(?\s*["'](\.[^"']+)["']''')
missing = []
for n in sorted(names):
    if not n.endswith(".js"):
        continue
    src = zf.read(n).decode("utf-8", "replace")
    base = posixpath.dirname(n)
    for spec in rx.findall(src):
        target = posixpath.normpath(posixpath.join(base, spec))
        cands = [target] + ([target + ".js"] if not target.endswith(".js") else [])
        if not any(c in names for c in cands):
            missing.append("%s imports '%s' -> %s (NOT in zip)" % (n, spec, target))
if missing:
    sys.stderr.write("\n✗ pack-zip: imported file(s) missing from the package:\n")
    for m in missing:
        sys.stderr.write("   " + m + "\n")
    sys.stderr.write("   Add the file to the zip list above in scripts/pack-zip.sh.\n\n")
    sys.exit(1)
print("✓ import check: all relative imports are packed")
PY

echo "Built $out"
unzip -Z1 "$out" | sed 's/^/  /'
