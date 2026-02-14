/**
 * AgentGate Demo Script
 *
 * Demonstrates the full 402 → pay → response flow.
 * Requires:
 *   - PRIVATE_KEY env var (agent wallet with pathUSD on Tempo testnet)
 *   - Demo server running on localhost:3000
 *
 * Usage:
 *   PRIVATE_KEY=0x... bun run apps/demo/scripts/agent-demo.ts
 */

import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentClient } from '@agentgate/client';
import { tempoTestnet, TOKENS, TIP20_ABI, formatAmount, DEFAULT_DECIMALS } from '@agentgate/core';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ Set PRIVATE_KEY env var to your Tempo testnet wallet private key');
    console.error('   Get testnet tokens at https://faucet.tempo.xyz');
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`🔑 Agent wallet: ${account.address}`);

  const publicClient = createPublicClient({
    chain: tempoTestnet,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account,
    chain: tempoTestnet,
    transport: http(),
  });

  // Check balance
  const balance = await publicClient.readContract({
    address: TOKENS.pathUSD,
    abi: TIP20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  console.log(`💰 pathUSD balance: ${formatAmount(balance as bigint, DEFAULT_DECIMALS)}\n`);

  const agent = new AgentClient({ walletClient, publicClient });

  // 1. Discover services
  console.log('━'.repeat(60));
  console.log('📡 Discovering services...');
  try {
    const services = await agent.discover(BASE_URL);
    console.log(`   Found: ${services.name}`);
    for (const svc of services.services) {
      console.log(`   • ${svc.endpoint} — ${svc.description} (${svc.price} USD)`);
    }
  } catch (e) {
    console.log(`   Discovery failed (server may not be running): ${(e as Error).message}`);
  }

  // 2. Echo endpoint
  console.log('\n' + '━'.repeat(60));
  console.log('📤 Calling POST /api/echo...');
  try {
    const echoRes = await agent.call(`${BASE_URL}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello from an AI agent!', agent: 'demo-agent-v1' }),
    });
    console.log(`   Response:`, await echoRes.json());
  } catch (e) {
    console.log(`   Error: ${(e as Error).message}`);
  }

  // 3. Weather endpoint
  console.log('\n' + '━'.repeat(60));
  console.log('🌤️  Calling GET /api/weather?city=tokyo...');
  try {
    const weatherRes = await agent.call(`${BASE_URL}/api/weather?city=tokyo`);
    console.log(`   Response:`, await weatherRes.json());
  } catch (e) {
    console.log(`   Error: ${(e as Error).message}`);
  }

  // 4. Inference endpoint
  console.log('\n' + '━'.repeat(60));
  console.log('🧠 Calling POST /api/inference...');
  try {
    const inferRes = await agent.call(`${BASE_URL}/api/inference`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Explain how AI agents can use blockchain for payments in one sentence.' }),
    });
    console.log(`   Response:`, await inferRes.json());
  } catch (e) {
    console.log(`   Error: ${(e as Error).message}`);
  }

  console.log('\n' + '━'.repeat(60));
  console.log('✅ Demo complete!');
}

main().catch(console.error);
