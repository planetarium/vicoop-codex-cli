#!/bin/sh
# vicoop-codex installer.
#
#   curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-codex-cli/main/scripts/install.sh | sh
#
# Auto-detects your platform, resolves the latest release (or a pinned one),
# downloads the matching standalone binary, verifies its SHA256 checksum, and
# installs it as `vicoop-codex`.
#
# Environment overrides:
#   VERSION       Install this exact version instead of the latest (e.g. 0.2.1).
#   INSTALL_DIR   Install into this directory (default: /usr/local/bin if
#                 writable, else $HOME/.local/bin).
set -eu

REPO="planetarium/vicoop-codex-cli"

err() { printf 'install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- pick a downloader -------------------------------------------------------
if have curl; then
  dl() { curl -fsSL "$1"; }
  dlo() { curl -fsSL -o "$2" "$1"; }
elif have wget; then
  dl() { wget -qO- "$1"; }
  dlo() { wget -qO "$2" "$1"; }
else
  err "need curl or wget on PATH"
fi

# --- detect platform ---------------------------------------------------------
case "$(uname -sm)" in
  "Darwin arm64")   ASSET="macos-arm64" ;;
  "Linux x86_64")   ASSET="linux-x64" ;;
  "Linux aarch64")  ASSET="linux-arm64" ;;
  *) err "no prebuilt binary for $(uname -sm) — see https://github.com/$REPO/releases" ;;
esac

# --- resolve version ---------------------------------------------------------
VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(dl "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$VERSION" ] || err "could not resolve the latest version from the GitHub API"
fi
VERSION="${VERSION#v}"

NAME="vicoop-codex-$VERSION-$ASSET"
BASE="https://github.com/$REPO/releases/download/v$VERSION"

# --- download + verify (in a temp dir) ---------------------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

printf 'install: downloading %s\n' "$NAME" >&2
dlo "$BASE/$NAME" "$TMP/$NAME" || err "download failed: $BASE/$NAME"

if dlo "$BASE/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt" 2>/dev/null; then
  EXPECTED=$(sed -n "s/^\([0-9a-f]\{64\}\)  *\*\{0,1\}$NAME\$/\1/p" "$TMP/SHA256SUMS.txt")
  [ -n "$EXPECTED" ] || err "no checksum entry for $NAME in SHA256SUMS.txt"
  if have sha256sum; then
    ACTUAL=$(sha256sum "$TMP/$NAME" | cut -d' ' -f1)
  elif have shasum; then
    ACTUAL=$(shasum -a 256 "$TMP/$NAME" | cut -d' ' -f1)
  else
    ACTUAL=""
    printf 'install: no sha256sum/shasum found; skipping checksum verification\n' >&2
  fi
  if [ -n "$ACTUAL" ]; then
    [ "$ACTUAL" = "$EXPECTED" ] || err "checksum mismatch for $NAME (expected $EXPECTED, got $ACTUAL)"
    printf 'install: checksum verified\n' >&2
  fi
else
  printf 'install: SHA256SUMS.txt unavailable; skipping checksum verification\n' >&2
fi

chmod +x "$TMP/$NAME"

# --- choose install dir ------------------------------------------------------
if [ -n "${INSTALL_DIR:-}" ]; then
  DIR="$INSTALL_DIR"
elif [ -w /usr/local/bin ] 2>/dev/null; then
  DIR="/usr/local/bin"
else
  DIR="$HOME/.local/bin"
fi
mkdir -p "$DIR" || err "cannot create install dir: $DIR"

DEST="$DIR/vicoop-codex"
if mv "$TMP/$NAME" "$DEST" 2>/dev/null; then
  :
elif have sudo; then
  printf 'install: %s is not writable, retrying with sudo\n' "$DIR" >&2
  sudo mv "$TMP/$NAME" "$DEST" || err "could not move binary into $DIR"
else
  err "cannot write to $DIR (set INSTALL_DIR to a writable directory)"
fi

printf 'install: installed vicoop-codex %s -> %s\n' "$VERSION" "$DEST" >&2
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) printf 'install: note - %s is not on your PATH; add it to run vicoop-codex directly\n' "$DIR" >&2 ;;
esac

"$DEST" --version
