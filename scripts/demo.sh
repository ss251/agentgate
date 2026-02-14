#!/bin/bash
set -e

echo "🚀 AgentGate Demo"
echo "=================="
echo ""

# Start gateway in background
echo "Starting gateway..."
bun run apps/gateway/src/index.ts &
GATEWAY_PID=$!
sleep 2

echo ""
echo "Gateway running on http://localhost:3402"
echo ""

# Run agent demo
echo "Running agent demo (discover + pay + execute)..."
echo ""

bun -e "
import { AgentGateClient } from './packages/sdk/src/index.ts';

const agent = new AgentGateClient({
  privateKey: '0x4afc13e37cdba626e6075f85b82d23e9ba66c73faa7b3af920ad6da320a8ecfb',
});

console.log('Agent address:', agent.address);

// Check balance
const balance = await agent.getBalance();
console.log('Balance:', (Number(balance) / 1e6).toFixed(2), 'pathUSD');
console.log('');

// Discover services
const services = await agent.discover('http://localhost:3402');
console.log('Available services:');
for (const ep of services.endpoints) {
  console.log('  ', ep.method, ep.path, '-', ep.price, 'pathUSD -', ep.description);
}
console.log('');

// Execute code
console.log('=== Code Execution ===');
const execRes = await agent.fetch('http://localhost:3402/api/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: 'console.log(\"Hello from AgentGate! 2+2=\", 2+2)', language: 'typescript' }),
});
const execData = await execRes.json();
console.log('Output:', execData.stdout.trim());
console.log('');

// Scrape
console.log('=== Web Scraping ===');
const scrapeRes = await agent.fetch('http://localhost:3402/api/scrape', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.com', format: 'text' }),
});
const scrapeData = await scrapeRes.json();
console.log('Title:', scrapeData.title);
console.log('Words:', scrapeData.wordCount);
console.log('');

// Deploy
console.log('=== Site Deployment ===');
const deployRes = await agent.fetch('http://localhost:3402/api/deploy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ html: '<h1>Deployed by an AI Agent!</h1><p>Paid with pathUSD on Tempo.</p>', title: 'AgentGate Demo' }),
});
const deployData = await deployRes.json();
console.log('Deployed at:', deployData.url);
console.log('');

// Final balance
const finalBalance = await agent.getBalance();
console.log('Final balance:', (Number(finalBalance) / 1e6).toFixed(2), 'pathUSD');
console.log('Spent:', ((Number(balance) - Number(finalBalance)) / 1e6).toFixed(4), 'pathUSD');
"

echo ""
echo "✅ Demo complete!"

# Cleanup
kill $GATEWAY_PID 2>/dev/null
