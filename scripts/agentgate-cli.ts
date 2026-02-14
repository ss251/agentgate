#!/usr/bin/env bun
/**
 * AgentGate CLI — pay-per-call API access on Tempo blockchain.
 * Usage:
 *   bun agentgate-cli.ts discover [gateway-url]
 *   bun agentgate-cli.ts balance
 *   bun agentgate-cli.ts execute --code '<code>' [--language typescript|python|shell]
 *   bun agentgate-cli.ts scrape --url <url>
 *   bun agentgate-cli.ts deploy --html '<html>'
 */

import { AgentGateClient } from '../packages/sdk/src/index';

const GATEWAY_URL = process.env.AGENTGATE_GATEWAY_URL ?? 'http://localhost:3402';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Error: AGENT_PRIVATE_KEY env var required');
  process.exit(1);
}

const client = new AgentGateClient({
  privateKey: PRIVATE_KEY as `0x${string}`,
  onPaymentEvent: (e) => {
    if (e.type === 'payment_required') console.error(`💰 Payment: ${e.amount} ${e.token}`);
    if (e.type === 'payment_confirmed') console.error(`✅ Tx: ${e.txHash}`);
  },
});

const [cmd, ...args] = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main() {
  switch (cmd) {
    case 'discover': {
      const info = await client.discover(args[0] || GATEWAY_URL);
      console.log(JSON.stringify(info, null, 2));
      break;
    }
    case 'balance': {
      const bal = await client.getBalance();
      console.log(JSON.stringify({ address: client.address, balance: bal }, null, 2));
      break;
    }
    case 'execute': {
      const code = getArg('code');
      const language = getArg('language') ?? 'typescript';
      if (!code) { console.error('--code required'); process.exit(1); }
      const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }
    case 'scrape': {
      const url = getArg('url');
      if (!url) { console.error('--url required'); process.exit(1); }
      const res = await client.fetch(`${GATEWAY_URL}/api/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }
    case 'deploy': {
      const html = getArg('html');
      if (!html) { console.error('--html required'); process.exit(1); }
      const res = await client.fetch(`${GATEWAY_URL}/api/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      });
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }
    default:
      console.error('Commands: discover, balance, execute, scrape, deploy');
      process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
