#!/usr/bin/env bash
# Install (or update) this bundle into a dsh profile through `dsh plugin`.
#
# Usage: scripts/install-profile.sh [profile-name]   (default: web)
#
# `dsh plugin` forwards to pnpm inside the profile directory, links this
# package, and reconciles dsh.profile.bundles automatically. Restart the
# dsh process afterwards to load the plugin.
set -euo pipefail
PROFILE="${1:-web}"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$PLUGIN_DIR/lib/index.mjs" ]; then
  echo "lib/index.mjs missing — building first..."
  (cd "$PLUGIN_DIR" && pnpm run build)
fi

if ! command -v dsh >/dev/null 2>&1; then
  # Fall back to the DSH checkout launcher when `dsh` is not on PATH.
  DSH_CHECKOUT="$PLUGIN_DIR/../../../dc-harness/deepseek-harness"
  if [ -f "$DSH_CHECKOUT/package.json" ]; then
    echo "linking $PLUGIN_DIR into profile '$PROFILE' (via DSH checkout launcher)..."
    exec node --import tsx/esm "$DSH_CHECKOUT/apps/cli/src/bin.ts" plugin --profile "$PROFILE" add "link:$PLUGIN_DIR"
  fi
  echo "error: 'dsh' not found on PATH and no DSH checkout at $DSH_CHECKOUT" >&2
  exit 127
fi

echo "linking $PLUGIN_DIR into profile '$PROFILE'..."
exec dsh plugin --profile "$PROFILE" add "link:$PLUGIN_DIR"
