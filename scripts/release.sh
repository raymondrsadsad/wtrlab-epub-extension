#!/usr/bin/env bash
# One-shot backup + publish for an update.
# 1. Bump "version" in manifest.json first, then run this.
# It packs a versioned zip (old zips are KEPT as backups), commits everything,
# tags the commit vX.Y.Z, and pushes main + the tag to GitHub.
#
# Roll back a bad update:
#   git reset --hard v<last-good>      # code back to that release
#   (or) reinstall dist/novel-to-epub-<last-good>.zip on the device
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
tag="v$version"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists — bump \"version\" in manifest.json before releasing." >&2
  exit 1
fi

scripts/pack-zip.sh                       # builds dist/novel-to-epub-$version.zip, keeps older zips
git add -A
git commit -q -m "Release $version" || echo "  (nothing new to commit)"
git tag -a "$tag" -m "Release $version"
git push origin main "$tag"

echo "Released $tag"
echo "  backup zip : dist/novel-to-epub-$version.zip"
echo "  git restore point: $tag"
