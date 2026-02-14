#!/usr/bin/env bun
/**
 * Live demo — real agent paying for services on the deployed gateway
 */
const { AgentGateClient } = await import('../packages/sdk/src/index');

const GATEWAY = 'https://gateway-production-aa5c.up.railway.app';

const client = new AgentGateClient({
  privateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  onPaymentEvent: (e: any) => {
    if (e.type === 'payment_required') console.log(`\n💰 Payment required: ${e.amount} ${e.token}`);
    if (e.type === 'payment_confirmed') console.log(`✅ Paid on Tempo: ${e.txHash}`);
  },
});

console.log('🤖 AgentGate Live Demo');
console.log(`📡 Gateway: ${GATEWAY}`);
console.log(`💳 Agent wallet: ${client.address}\n`);

// 1. Discover
console.log('═══ Step 1: Discover Services ═══');
const info = await client.discover(GATEWAY);
console.log(`Found ${info.endpoints.length} paid services:`);
for (const ep of info.endpoints) {
  console.log(`  ${ep.method} ${ep.path} — ${ep.price} pathUSD — ${ep.description}`);
}

// 2. Check balance
console.log('\n═══ Step 2: Check Balance ═══');
const bal = await client.getBalance();
const { formatUnits } = await import('viem');
console.log(`Balance: ${formatUnits(bal, 6)} pathUSD`);

// 3. LLM Chat (the inference endpoint!)
console.log('\n═══ Step 3: LLM Inference (0.005 pathUSD) ═══');
const chatRes = await client.fetch(`${GATEWAY}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    messages: [{ role: 'user', content: 'What is AgentGate in one sentence?' }]
  }),
});
const chatResult = await chatRes.json() as any;
console.log(`🤖 LLM says: ${chatResult.choices?.[0]?.message?.content || chatResult.response || JSON.stringify(chatResult).slice(0, 200)}`);

// 4. Execute code
console.log('\n═══ Step 4: Code Execution (0.01 pathUSD) ═══');
const execRes = await client.fetch(`${GATEWAY}/api/execute`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    code: `
const now = new Date().toISOString();
const prices = { BTC: 97500, ETH: 3200, SOL: 180 };
console.log("Agent market check at " + now);
Object.entries(prices).forEach(([k,v]) => console.log("  " + k + ": $" + v.toLocaleString()));
console.log("Agent recommends: HOLD");
    `,
    language: 'typescript' 
  }),
});
const execResult = await execRes.json() as any;
console.log(`📤 Output:\n${execResult.stdout}`);

// 5. Web scrape
console.log('═══ Step 5: Web Scraping (0.005 pathUSD) ═══');
const scrapeRes = await client.fetch(`${GATEWAY}/api/scrape`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://tempo.xyz' }),
});
const scrapeResult = await scrapeRes.json() as any;
console.log(`🌐 Scraped: ${scrapeResult.title || 'tempo.xyz'}`);
console.log(`   Content: ${(scrapeResult.text || '').slice(0, 150)}...`);

// 6. Deploy a site
console.log('\n═══ Step 6: Site Deployment (0.05 pathUSD) ═══');
const deployRes = await client.fetch(`${GATEWAY}/api/deploy`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    html: `<!DOCTYPE html>
<html><head><title>Agent-Deployed Site</title>
<style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;background:#0a0a0a;color:#e5e5e5}
h1{background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:20px;margin:16px 0}
code{color:#34d399}</style></head>
<body>
<h1>🚪 Deployed by an AI Agent</h1>
<div class="card">
<p>This site was autonomously deployed by an AI agent using <strong>AgentGate</strong>.</p>
<p>The agent paid <code>0.05 pathUSD</code> on <strong>Tempo blockchain</strong> to deploy this page.</p>
<p>No human intervention. No API keys. Just crypto payments.</p>
</div>
<div class="card">
<p>⛓️ Chain: Tempo Testnet (42431)</p>
<p>💰 Payment: pathUSD stablecoin</p>
<p>🤖 Agent: autonomous AI with Privy wallet</p>
<p>⏰ Deployed: ${new Date().toISOString()}</p>
</div>
</body></html>`
  }),
});
const deployResult = await deployRes.json() as any;
console.log(`🚀 Deployed! URL: ${deployResult.url || deployResult.siteUrl || JSON.stringify(deployResult)}`);

// Summary
console.log('\n═══ Summary ═══');
console.log('Agent autonomously:');
console.log('  1. Discovered 4 paid services');
console.log('  2. Asked an LLM a question (paid 0.005 pathUSD)');
console.log('  3. Executed code remotely (paid 0.01 pathUSD)');
console.log('  4. Scraped a website (paid 0.005 pathUSD)');
console.log('  5. Deployed a website (paid 0.05 pathUSD)');
console.log('  Total spent: ~0.07 pathUSD on Tempo testnet');
console.log(`\n🔗 Check dashboard: ${GATEWAY}/dashboard`);
