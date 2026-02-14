#!/usr/bin/env bun
/**
 * Start gateway + demo AgentGate CLI in one process.
 * Uses Bun.spawn to start the gateway as a child process.
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
console.log('⏳ Waiting for gateway...');
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(GATEWAY_URL);
    if (res.ok) { console.log('✅ Gateway ready!'); break; }
  } catch {}
  await new Promise(r => setTimeout(r, 500));
}

const client = new AgentGateClient({
  privateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  onPaymentEvent: (e: any) => {
    if (e.type === 'payment_required') console.log(`💰 Payment required: ${e.amount} ${e.token}`);
    if (e.type === 'payment_confirmed') console.log(`✅ Paid: ${e.txHash}`);
  },
});

// 1. Discover
console.log('\n🔍 Discovering services...');
const info = await client.discover(GATEWAY_URL);
console.log(`Found ${info.endpoints.length} endpoints: ${info.endpoints.map((e: any) => e.path).join(', ')}`);

// 2. Check balance
console.log('\n💳 Checking wallet balance...');
const bal = await client.getBalance();
console.log(`Address: ${client.address}`);
console.log(`Balance: ${bal} pathUSD`);

// 3. Execute code
console.log('\n🚀 Executing TypeScript (costs 0.01 pathUSD)...');
const execRes = await client.fetch(`${GATEWAY_URL}/api/execute`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: 'console.log("Hello from AgentGate! 2+2=" + (2+2))', language: 'typescript' }),
});
const execResult = await execRes.json() as any;
console.log(`Output: ${execResult.stdout?.trim()}`);

// 4. Scrape
console.log('\n🌐 Scraping example.com (costs 0.005 pathUSD)...');
const scrapeRes = await client.fetch(`${GATEWAY_URL}/api/scrape`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.com' }),
});
const scrapeResult = await scrapeRes.json() as any;
console.log(`Title: ${scrapeResult.title}`);
console.log(`Content length: ${scrapeResult.text?.length} chars`);

console.log('\n✅ All done! Agent autonomously discovered, paid, and used services on Tempo.');
gw.kill();
process.exit(0);
