#!/usr/bin/env bash
# Install the review board into ~/.claude so it applies to every project on
# this machine, not just this repo.
#
#   bash .claude/install-globally.sh
#
# Existing files are backed up next to themselves with a .bak suffix rather
# than overwritten, so nothing you already had is lost.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$SRC")"
DEST="$HOME/.claude"

backup() {
  [ -e "$1" ] && cp -r "$1" "$1.bak" && echo "  backed up $(basename "$1") → $(basename "$1").bak"
  return 0
}

echo "Installing review board → $DEST"

mkdir -p "$DEST/agents" "$DEST/skills"

for agent in "$SRC"/agents/*.md; do
  name="$(basename "$agent")"
  backup "$DEST/agents/$name"
  cp "$agent" "$DEST/agents/$name"
  echo "  agent:  ${name%.md}"
done

for skill in "$SRC"/skills/*/; do
  name="$(basename "$skill")"
  backup "$DEST/skills/$name"
  rm -rf "$DEST/skills/$name"
  cp -r "$skill" "$DEST/skills/$name"
  echo "  skill:  /$name"
done

# The working agreement is per-user memory at ~/.claude/CLAUDE.md. If one
# already exists it is almost certainly hand-written, so append rather than
# replace and let the user merge.
if [ -f "$DEST/CLAUDE.md" ]; then
  if grep -q "^# Working agreement" "$DEST/CLAUDE.md"; then
    echo "  memory: ~/.claude/CLAUDE.md already contains this agreement — left alone"
  else
    backup "$DEST/CLAUDE.md"
    printf '\n\n' >> "$DEST/CLAUDE.md"
    cat "$REPO/CLAUDE.md" >> "$DEST/CLAUDE.md"
    echo "  memory: appended to existing ~/.claude/CLAUDE.md — review the merge"
  fi
else
  cp "$REPO/CLAUDE.md" "$DEST/CLAUDE.md"
  echo "  memory: ~/.claude/CLAUDE.md"
fi

echo
echo "Done. Restart Claude Code, then check with:  /agents"
