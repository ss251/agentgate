# AgentGate 🚪💰

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-orange)](https://bun.sh)
[![Tempo Network](https://img.shields.io/badge/Chain-Tempo%20Testnet-purple)](https://tempo.xyz)

**HTTP 402 Payment Protocol for AI Agents on Tempo**

AgentGate enables AI agents to discover and pay for API services using on-chain TIP-20 stablecoin transfers. When an agent hits a paid endpoint, it gets a `402 Payment Required` response, sends a pathUSD transfer on Tempo, and retries with the tx hash — all automatic.

## Why AgentGate?

AI agents need to consume APIs — code execution, web scraping, deployments, and more. But how do they *pay* for these services?

Traditional approaches (API keys, subscriptions, OAuth) don't work for autonomous agents. AgentGate implements the [HTTP 402 Payment Required](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402) standard with on-chain payments:

- **🤖 Agent-native** — No API keys, no accounts. Just a wallet and pathUSD.
- **⚡ Instant** — Pay-per-call with sub-second Tempo finality.
- **🔍 Discoverable** — `.well-known/x-agentgate.json` lets agents find and price services automatically.
- **🔒 Verifiable** — Every payment is an on-chain TIP-20 transfer. No trust required.
- **💸 Micro-payments** — Pay $0.005 for a single scrape. No minimums.

Inspired by [Coinbase x402](https://github.com/coinbase/x402) and built on [Tempo](https://tempo.xyz).

## How It Works

```
Agent                    Gateway                  Tempo Chain
  │                        │                          │
  │── POST /api/execute ──►│                          │
  │◄── 402 + payment req ──│                          │
  │                        │                          │
  │── transfer pathUSD ────│─────────────────────────►│
  │◄── tx confirmed ───────│──────────────────────────│
  │                        │                          │
  │── POST /api/execute ──►│                          │
  │   (X-Payment: tx:chain)│── verify on-chain ──────►│
  │◄── 200 + result ───────│                          │
```

## Architecture

```
agentgate/
├── packages/
│   ├── core/           Chain defs, token addresses, payment verification, types
│   ├── middleware/      Hono paywall() middleware — returns 402, verifies payments
│   └── sdk/            AgentGateClient — auto 402 → pay → retry for agents
├── apps/
│   └── gateway/        Live gateway with real services (execute, scrape, deploy)
├── tests/
│   ├── unit/           Unit tests for core, middleware, SDK
│   └── e2e.test.ts     End-to-end tests with real on-chain payments
└── scripts/
    └── demo.sh         Full demo script
```

## Quick Start

```bash
# Install dependencies
bun install

# Start the gateway
bun run apps/gateway/src/index.ts

# Gateway runs on http://localhost:3402
# Dashboard at http://localhost:3402/dashboard
```

## Services

| Endpoint | Price | Description |
|----------|-------|-------------|
| `POST /api/execute` | 0.01 pathUSD | Run TypeScript, Python, or shell code |
| `POST /api/scrape` | 0.005 pathUSD | Fetch and extract content from URLs |
| `POST /api/deploy` | 0.05 pathUSD | Deploy HTML and get a live URL |

**Free endpoints:** `/`, `/dashboard`, `/api/health`, `/api/sites`, `/.well-known/x-agentgate.json`

## SDK Usage (Agent Side)

```typescript
import { AgentGateClient } from '@tempo-agentgate/sdk';

const agent = new AgentGateClient({
  privateKey: '0x...',  // Agent's private key (funded with pathUSD)
});

// Discover available services
const services = await agent.discover('http://localhost:3402');

// Call a paid endpoint — payment is automatic!
const res = await agent.fetch('http://localhost:3402/api/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: 'console.log(2 + 2)', language: 'typescript' }),
});

const data = await res.json();
// { stdout: "4\n", stderr: "", exitCode: 0, executionTimeMs: 42 }
```

### SDK Features

- **Auto-pay**: Detects 402 responses and handles payment + retry automatically
- **Balance pre-check**: Fails fast if insufficient funds
- **Retry with backoff**: Handles transient failures with exponential backoff
- **Payment callbacks**: Monitor payment lifecycle events
- **Batch calls**: `fetchMany()` for parallel requests

```typescript
const agent = new AgentGateClient({
  privateKey: '0x...',
  maxRetries: 3,
  timeoutMs: 30000,
  onPaymentEvent: (event) => {
    if (event.type === 'payment_confirmed') console.log('Paid:', event.txHash);
  },
});
```

## Middleware Usage (Provider Side)

```typescript
import { Hono } from 'hono';
import { paywall } from '@tempo-agentgate/middleware';

const app = new Hono();

app.use('/api/*', paywall({
  recipientAddress: '0x...', // Your wallet
  token: 'pathUSD',
  pricing: {
    'POST /api/myservice': { amount: '0.01', description: 'My Service' },
  },
  onPayment: async ({ from, amount, txHash }) => {
    console.log(`Received payment from ${from}`);
  },
}));

app.post('/api/myservice', (c) => c.json({ result: 'paid content' }));
```

## Security Model

The code execution endpoint (`/api/execute`) implements multiple layers of protection:

| Layer | Protection |
|-------|-----------|
| **Input limits** | Max 10KB code, max 50KB stdout |
| **Timeout** | 10-second hard kill for all executions |
| **Shell blocklist** | Blocks `rm -rf /`, fork bombs, `curl\|sh`, etc. |
| **Restricted env** | Only `PATH` exposed, runs in isolated temp dir |
| **Process isolation** | Each execution is a separate Bun.spawn process |
| **Replay protection** | Each tx hash can only be used once |

> ⚠️ **Note:** This is not a full sandbox. For production use, consider [nsjail](https://github.com/google/nsjail), [gVisor](https://gvisor.dev/), or [Firecracker](https://firecracker-microvm.github.io/).

## Service Discovery

Agents discover services via the well-known endpoint:

```bash
curl http://localhost:3402/.well-known/x-agentgate.json
```

## Chain Details

- **Network:** Tempo Testnet (Moderato)
- **Chain ID:** 42431
- **RPC:** `https://rpc.moderato.tempo.xyz`
- **Explorer:** `https://explorer.moderato.tempo.xyz`
- **Token:** pathUSD (6 decimals) at `0x20c0000000000000000000000000000000000000`

## Testing

```bash
# Unit tests (fast, no chain needed)
bun test tests/unit/

# Full E2E tests (requires Tempo testnet + funded wallet)
bun test tests/e2e.test.ts

# All tests
bun test
```

## Demo

```bash
./scripts/demo.sh
```

Runs the full flow: start gateway → discover services → pay & execute code → pay & scrape → pay & deploy → show final balance.

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make changes and add tests
4. Run `bun test` to verify
5. Submit a PR

## Links

- [Tempo Network](https://tempo.xyz)
- [Tempo Docs](https://docs.tempo.xyz)
- [x402 Protocol (Coinbase)](https://github.com/coinbase/x402)
- [HTTP 402 Spec](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402)

## License

MIT
