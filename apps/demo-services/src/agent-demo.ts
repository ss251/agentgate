/**
 * Demo: An AI agent using AgentGate SDK to pay for API calls on Tempo.
 * 
 * Usage:
 *   AGENT_PRIVATE_KEY=0x... bun run src/agent-demo.ts
 */
import { AgentGateClient } from '@agentgate/sdk';
import { formatUnits } from 'viem';
import type { Hex } from 'viem';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3402';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY as Hex;

if (!PRIVATE_KEY) {
  console.error('❌ Set AGENT_PRIVATE_KEY env var');
  process.exit(1);
}

async function main() {
  console.log('🤖 Initializing AgentGate client...\n');

  const agent = new AgentGateClient({ privateKey: PRIVATE_KEY });
  console.log(`   Agent address: ${agent.address}`);

  // Check balance
  const balance = await agent.getBalance('pathUSD');
  console.log(`   pathUSD balance: ${formatUnits(balance, 18)}\n`);

  // Discover available services
  console.log('🔍 Discovering services...');
  try {
    const services = await agent.discover(GATEWAY_URL);
    console.log(`   Found ${services.endpoints.length} paid endpoints:`);
    for (const ep of services.endpoints) {
      console.log(`   • ${ep.method} ${ep.path} — ${ep.price} ${services.token.symbol} (${ep.description})`);
    }
  } catch {
    console.log('   Discovery not available, proceeding with known endpoints');
  }

  // Call a paid endpoint
  console.log('\n💬 Calling /api/chat (0.01 pathUSD)...');
  const chatRes = await agent.fetch(`${GATEWAY_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'What is Tempo blockchain?' }),
  });

  if (chatRes.ok) {
    const data = await chatRes.json();
    console.log(`   ✅ Response: ${JSON.stringify(data, null, 2)}`);
  } else {
    console.log(`   ❌ Failed: ${chatRes.status} ${await chatRes.text()}`);
  }

  // Check updated balance
  const newBalance = await agent.getBalance('pathUSD');
  console.log(`\n💰 pathUSD balance after: ${formatUnits(newBalance, 18)}`);
  console.log(`   Spent: ${formatUnits(balance - newBalance, 18)} pathUSD`);
}

main().catch(console.error);
