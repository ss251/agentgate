#!/bin/bash
# Start gateway + cloudflare tunnel
# Run this in a terminal: cd tempo-hackathon && bash scripts/serve.sh

set -e
cd "$(dirname "$0")/.."
source .env

echo "🚀 Starting AgentGate gateway..."
bun run apps/gateway/src/index.ts &
GW_PID=$!

sleep 3

echo "🌐 Starting Cloudflare tunnel..."
cloudflared tunnel --url http://localhost:3402 &
CF_PID=$!

echo ""
echo "Gateway PID: $GW_PID"
echo "Tunnel PID: $CF_PID"
echo "Press Ctrl+C to stop both"

trap "kill $GW_PID $CF_PID 2>/dev/null; exit" INT TERM
wait
