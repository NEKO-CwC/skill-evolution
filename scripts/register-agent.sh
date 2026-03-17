#!/usr/bin/env bash
# Register the skill-evolution agent with OpenClaw.
# Usage: ./scripts/register-agent.sh [workspace_dir]
#
# This creates a single top-level agent visible in the WebUI.
# Review and notify are internal sessions of this agent, not separate agents.

set -euo pipefail

WORKSPACE="${1:-${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}}"
AGENT_ID="skill-evolution"

echo "Registering agent: $AGENT_ID"
echo "Workspace: $WORKSPACE"

# Check if agent already exists
if openclaw agents list 2>/dev/null | grep -q "^- $AGENT_ID"; then
  echo "Agent '$AGENT_ID' already registered. Skipping."
  exit 0
fi

openclaw agents add "$AGENT_ID" \
  --workspace "$WORKSPACE" \
  --non-interactive

echo ""
echo "Done. Verify with: openclaw agents list"
echo ""
echo "To configure the agent's model, edit openclaw.json:"
echo "  agents.list[] → find id='$AGENT_ID' → set model"
