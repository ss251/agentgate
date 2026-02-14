#!/usr/bin/env bun
/**
 * Test AgentGate with Privy server wallet — full E2E flow
 */
const { AgentGateClient } = await import('../packages/sdk/src/index');

const GATEWAY_URL = 'http://localhost:3402';

// Start gateway as child process
const gw = Bun.spawn(['bun', 'run', 'apps/gateway/src/index.ts'], {
  cwd: import.meta.dir + '/..',
  env: { ...process.env, PORT: '3402' },
  stdout: 'inherit',
  stderr: 'inherit',
});

// Wait for gateway
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(GATEWAY_URL);
    if (res.ok) break;
  } catch {}
  await new Promise(r => setTimeout(r, 500));
}

console.log('✅ Gateway ready\n');

// Create client with Privy wallet
const client = new AgentGateClient({
  privyAppId: process.env.PRIVY_APP_ID!,
  privyAppSecret: process.env.PRIVY_APP_SECRET!,
  walletId: 'p612laiwzni45lbif189crfz', // The wallet we just created and funded
  onPaymentEvent: (e: any) => {
    if (e.type === 'payment_required') console.log(`💰 Payment required: ${e.amount} ${e.token}`);
    if (e.type === 'payment_confirmed') console.log(`✅ Paid via Privy: ${e.txHash}`);
    if (e.type === 'error') console.log(`❌ Error: ${e.error}`);
  },
});

// Resolve address
console.log('🔑 Privy wallet address:', await client.resolveAddress());

// Execute code via Privy-powered payment
console.log('\n🚀 Executing code with Privy wallet (fee sponsored)...');
try {
  const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      code: 'console.log("Hello from Privy-powered AgentGate! " + new Date().toISOString())', 
      language: 'typescript' 
    }),
  });
  const result = await res.json() as any;
  console.log(`📤 Output: ${result.stdout?.trim()}`);
  console.log(`📊 Status: ${res.status}`);
} catch (e: any) {
  console.error('Failed:', e.message);
}

gw.kill();
process.exit(0);
