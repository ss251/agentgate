# AgentGate 🚪💰

**HTTP 402 Payment Protocol for AI Agents on Tempo**

AgentGate enables AI agents to discover and pay for API services using on-chain TIP-20 stablecoin transfers. When an agent hits a paid endpoint, it gets a `402 Payment Required` response, sends a pathUSD transfer on Tempo, and retries with the tx hash.

## How It Works

```
Agent                    Gateway                  Tempo Chain
  |                        |                          |
  |-- POST /api/execute -->|                          |
  |<-- 402 + payment req --|                          |
  |                        |                          |
  |-- transfer pathUSD ----|------------------------->|
  |<-- tx confirmed -------|--------------------------|
  |                        |                          |
  |-- POST /api/execute -->|                          |
  |   (X-Payment: tx:chain)|-- verify on-chain ------>|
  |<-- 200 + result -------|                          |
```

## Quick Start

```bash
bun install
bun run apps/gateway/src/index.ts
# Gateway runs on http://localhost:3402
```

## Services

| Endpoint | Price | Description |
|----------|-------|-------------|
| `POST /api/execute` | 0.01 pathUSD | Run TypeScript, Python, or shell code |
| `POST /api/scrape` | 0.005 pathUSD | Fetch and extract content from URLs |
| `POST /api/deploy` | 0.05 pathUSD | Deploy HTML and get a live URL |

## SDK Usage (Agent Side)

```typescript
import { AgentGateClient } from '@agentgate/sdk';

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

## Middleware Usage (Provider Side)

```typescript
import { Hono } from 'hono';
import { paywall } from '@agentgate/middleware';

const app = new Hono();

app.use('/api/*', paywall({
  recipientAddress: '0x...', // Your wallet
  token: 'pathUSD',
  pricing: {
    'POST /api/myservice': { amount: '0.01', description: 'My Service' },
  },
}));

app.post('/api/myservice', (c) => c.json({ result: 'paid content' }));
```

## Service Discovery

```bash
curl http://localhost:3402/.well-known/x-agentgate.json
```

## Architecture

```
packages/
  core/        — Chain defs, token addresses, payment verification, types
  middleware/  — Hono paywall() middleware (returns 402, verifies payments)
  sdk/         — AgentGateClient with auto 402→pay→retry
apps/
  gateway/     — Demo gateway with real services (execute, scrape, deploy)
```

## Chain Details

- **Network:** Tempo Testnet (Moderato)
- **Chain ID:** 42431
- **RPC:** https://rpc.moderato.tempo.xyz
- **Token:** pathUSD (6 decimals) at `0x20c0000000000000000000000000000000000000`

## Testing

```bash
bun test
```

Tests run against Tempo testnet with real on-chain payments.

## License

MIT
