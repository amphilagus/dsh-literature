#!/usr/bin/env bash
# Recreate the @deepseek-ai symlinks under node_modules/ that the DSH checkout
# provides for typecheck/tests. Run after `pnpm install` wiped node_modules.
# Symlinks are absolute so they survive regardless of where the package
# directory lives.
#
# Resolution order:
#   1. $DSH_CHECKOUT
#   2. ../deepseek-harness (this workspace)
#   3. ../../../dc-harness/deepseek-harness (the original out-of-tree layout)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "${DSH_CHECKOUT:-}" ]; then
  H="$(cd "$DSH_CHECKOUT" && pwd)"
elif [ -f ../deepseek-harness/package.json ]; then
  H="$(cd ../deepseek-harness && pwd)"
else
  H="$(cd ../../../dc-harness/deepseek-harness && pwd)"
fi
mkdir -p node_modules/@deepseek-ai

ln -sfn "$H/vendor/cordis" node_modules/@deepseek-ai/cordis
ln -sfn "$H/packages/core/tools" node_modules/@deepseek-ai/dsh-tools
ln -sfn "$H/packages/llm/llm" node_modules/@deepseek-ai/dsh-llm
ln -sfn "$H/packages/util/home-paths" node_modules/@deepseek-ai/dsh-home-paths
ln -sfn "$H/packages/sandbox/sandbox-policy" node_modules/@deepseek-ai/dsh-sandbox-policy
ln -sfn "$H/packages/core/system-prompt" node_modules/@deepseek-ai/dsh-system-prompt
ln -sfn "$H/packages/core/session" node_modules/@deepseek-ai/dsh-session
ln -sfn "$H/packages/core/agent" node_modules/@deepseek-ai/dsh-agent
ln -sfn "$H/packages/core/agent-loop" node_modules/@deepseek-ai/dsh-agent-loop
ln -sfn "$H/packages/test-support/agent-loop-testkit" node_modules/@deepseek-ai/dsh-agent-loop-testkit
ln -sfn "$H/packages/skill/skill" node_modules/@deepseek-ai/dsh-skill

echo "links ready -> $H"
