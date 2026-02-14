# AgentGate 🚪💰

**Pay-per-call API access for AI agents on Tempo blockchain.**

AgentGate is a TypeScript toolkit that lets AI agents pay for API endpoints using stablecoins on [Tempo](https://tempo.xyz). Service providers add a single middleware to monetize their APIs. Agents auto-pay using the HTTP 402 protocol.

## How It Works

```
Agent → GET /api/chat → 402 Payment Required (price: 0.01 pathUSD)
Agent → Sends 0.01 pathUSD on Tempo (instant, ~0 fees)
Agent → GET /api/chat + X-Payment: <txHash>:42431 → 200 OK ✅
```

No accounts. No API keys. No subscriptions. Just HTTP + blockchain.

## Packages

| Package | Description |
|---------|------------|
| `@agentgate/core` | Chain definitions, token addresses, payment verification, utilities |
| `@agentgate/middleware` | Hono `paywall()` middleware — one line to monetize any endpoint |
| `@agentgate/sdk` | Agent client SDK — auto 402→pay→retry flow |

## Quick Start

### Provider (monetize your API)

```typescript
import { Hono } from 'hono';
import { paywall } from '@agentgate/middleware';

const app = new Hono();

app.use('/api/*', paywall({
  recipientAddress: '0xYourWallet',
  pricing: {
    'POST /api/chat': { amount: '0.01', description: 'LLM Chat' },
    'GET /api/weather': { amount: '0.001', description: 'Weather Data' },
  },
}));

app.post('/api/chat', (c) => c.json({ response: 'Hello from a paid API!' }));
```

### Agent (pay for APIs automatically)

```typescript
import { AgentGateClient } from '@agentgate/sdk';

const agent = new AgentGateClient({ privateKey: '0x...' });

// Automatic: detects 402 → pays on Tempo → retries → returns result
const res = await agent.fetch('https://api.example.com/api/chat', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'Hello' }),
});
const data = await res.json();
```

### Service Discovery

Providers expose `/.well-known/x-agentgate.json`:

```json
{
  "name": "My API",
  "chain": { "id": 42431, "name": "Tempo Testnet" },
  "token": { "symbol": "pathUSD", "address": "0x20c0..." },
  "endpoints": [
    { "method": "POST", "path": "/api/chat", "price": "0.01" }
  ]
}
```

Agents can crawl this to discover and auto-pay for services.

## Why Tempo?

- **Instant finality** — payment verification in the same HTTP request
- **Stablecoin-native** — no volatile gas tokens, pay fees in USD stablecoins
- **Fee sponsorship** — platforms can sponsor agent gas fees for zero-friction onboarding
- **Transfer memos** — tie every payment to a specific API call on-chain

## Architecture

```
┌──────────┐   1. Request    ┌────────────────┐
│ AI Agent │ ───────────────► │  Provider API  │
│  (SDK)   │ ◄─── 2. 402 ─── │  (+ paywall)   │
│          │                  └────────────────┘
│          │   3. Pay pathUSD        │
│          │ ──────────────► ┌──────────────┐
│          │                 │    Tempo      │
│          │ ◄── 4. tx hash  │  Blockchain   │
│          │                 └──────────────┘
│          │   5. Retry + X-Payment
│          │ ───────────────► ┌────────────────┐
│          │ ◄─── 6. 200 ─── │  Provider API  │
└──────────┘    (verified!)   └────────────────┘
```

## Development

```bash
bun install
bun run apps/gateway/src/index.ts   # Start demo gateway on :3402
```

## Built for

🏆 **Canteen x Tempo Hackathon** — Track 3: AI Agents & Automation

## License

MIT
