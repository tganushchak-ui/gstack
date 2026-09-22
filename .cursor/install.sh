#!/usr/bin/env bash
# Cloud Agent install: bootstrap the gstack toolchain after checkout.
# Idempotent — safe to run repeatedly and against cached/snapshot state.
set -euo pipefail

# 1. Install Bun (pinned) if it is not already present. gstack is a Bun project
#    and Bun is not part of Cursor's default base image.
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export BUN_INSTALL
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  # Pin the Bun version for reproducible environments. The official installer
  # takes the version tag as its first positional arg (the BUN_VERSION env var
  # is NOT honored), so pass it via `bash -s "bun-v<version>"`.
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
fi

# Expose bun/bunx on the default PATH so every agent shell finds them without
# relying on shell-profile sourcing.
if command -v sudo >/dev/null 2>&1; then
  for tool in bun bunx; do
    if [ -x "$BUN_INSTALL/bin/$tool" ]; then
      sudo ln -sf "$BUN_INSTALL/bin/$tool" "/usr/local/bin/$tool" 2>/dev/null || true
    fi
  done
fi

# 2. Install JS dependencies from the committed lockfile.
bun install --frozen-lockfile

# 3. Install Playwright's Chromium (+ any missing system libraries). gstack's
#    core `browse` binary drives real Chromium. This is a no-op once cached.
bunx playwright install --with-deps chromium

# 4. Compile the browse/design/make-pdf binaries and generate skill docs.
bun run build

echo "gstack Cloud Agent environment ready."
