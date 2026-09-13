#!/bin/sh
# SkillOps - one-line installer for Linux / macOS (POSIX sh)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Jia-ben00/skillops/main/install.sh | sh
# Options (env vars): SKILLOPS_VERSION, SKILLOPS_HOME, SKILLOPS_BIN
set -e

VERSION="${SKILLOPS_VERSION:-0.5.0}"
DEST="${SKILLOPS_HOME:-$HOME/.local/share/skillops-cli}"
BIN="${SKILLOPS_BIN:-$HOME/.local/bin}"

command -v node >/dev/null 2>&1 || { echo "Error: Node.js >= 18 is required (https://nodejs.org)"; exit 1; }

mkdir -p "$DEST" "$BIN"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TGZ="$TMP/skillops-cli-$VERSION.tgz"

URL="https://github.com/Jia-ben00/skillops/releases/download/v$VERSION/skillops-cli-$VERSION.tgz"
echo "Downloading $URL ..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$TGZ" "$URL" || {
    echo "GitHub release asset not found, falling back to npm registry ..."
    curl -fsSL -o "$TGZ" "https://registry.npmjs.org/skillops-cli/-/skillops-cli-$VERSION.tgz"
  }
else
  wget -q -O "$TGZ" "$URL" || {
    echo "GitHub release asset not found, falling back to npm registry ..."
    wget -q -O "$TGZ" "https://registry.npmjs.org/skillops-cli/-/skillops-cli-$VERSION.tgz"
  }
fi

tar -xzf "$TGZ" -C "$TMP"
rm -rf "$DEST/package"
if [ -d "$TMP/package" ]; then
  mv "$TMP/package" "$DEST/package"
else
  # npm registry tgz may unpack into a single inner dir
  D="$(find "$TMP" -maxdepth 2 -name package.json -print -quit | xargs dirname 2>/dev/null || true)"
  [ -n "$D" ] && [ -d "$D" ] && mv "$D" "$DEST/package" || { echo "Error: unexpected tarball layout"; exit 1; }
fi

printf '#!/bin/sh\nexec node "%s/package/src/cli.js" "$@"\n' "$DEST" > "$BIN/skillops"
chmod +x "$BIN/skillops"

echo ""
echo "SkillOps v$VERSION installed to $DEST"
echo "Make sure $BIN is on your PATH, then run:  skillops doctor"
