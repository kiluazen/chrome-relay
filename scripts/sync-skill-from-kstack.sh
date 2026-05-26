#!/usr/bin/env bash
# Refresh skills/chrome-relay/ from the canonical copy in kiluazen/kstack.
# The mirror exists only so old extension popups showing
# `npx skills add kiluazen/chrome-relay` keep working — kstack is the source of truth.
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/kiluazen/kstack/main/skills/chrome-relay"
DEST="$(cd "$(dirname "$0")/.." && pwd)/skills/chrome-relay"

mkdir -p "$DEST/references"
curl -fsSL "$REPO_RAW/SKILL.md"                       -o "$DEST/SKILL.md.upstream"
curl -fsSL "$REPO_RAW/references/patterns.md"         -o "$DEST/references/patterns.md"
curl -fsSL "$REPO_RAW/references/troubleshooting.md"  -o "$DEST/references/troubleshooting.md"

# Re-insert the MIRROR banner after the frontmatter on every sync.
awk '
  BEGIN { fm = 0 }
  /^---$/ {
    print
    fm++
    if (fm == 2) {
      print ""
      print "<!--"
      print "  MIRROR — canonical source lives in github.com/kiluazen/kstack/skills/chrome-relay."
      print "  This copy exists so the old install command (`npx skills add kiluazen/chrome-relay`)"
      print "  shown by older versions of the Chrome extension popup keeps working."
      print "  After editing the canonical version in kstack, run scripts/sync-skill-from-kstack.sh"
      print "  to refresh this mirror."
      print "-->"
    }
    next
  }
  { print }
' "$DEST/SKILL.md.upstream" > "$DEST/SKILL.md"
rm "$DEST/SKILL.md.upstream"

echo "synced from kstack/main → chrome-relay/skills/chrome-relay/"
