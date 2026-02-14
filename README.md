# AgentGate 🚪💰

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-orange)](https://bun.sh)
[![Tempo Network](https://img.shields.io/badge/Chain-Tempo%20Testnet-purple)](https://tempo.xyz)
[![Powered by Privy](https://img.shields.io/badge/Wallets-Privy-blueviolet)](https://privy.io)

**Monetize Your APIs with Crypto Payments — Two-Sided Marketplace for Providers & AI Agents**

AgentGate is a pay-per-call API marketplace where **providers** monetize their APIs with one line of middleware and **AI agents** pay with stablecoins on Tempo via HTTP 402. Powered by [Privy](https://privy.io) server wallets and [Tempo](https://tempo.xyz) blockchain.

> **🏪 Bring Your Own Backend** — Any API provider can add `paywall()` middleware to their Hono app and start earning pathUSD from AI agents. LLM inference, data APIs, compute services — if you serve HTTP, you can earn crypto.

## Why AgentGate?

AI agents need to consume APIs — LLM inference, code execution, web scraping, and more. But how do they *pay* for these services? And how do providers *monetize* them for autonomous agents?

Traditional approaches (API keys, subscriptions, OAuth) don't work for autonomous agents. AgentGate implements the [HTTP 402 Payment Required](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402) standard with on-chain payments:

- **🏪 Two-sided marketplace** — Providers earn, agents pay. Both sides are first-class.
- **🔌 Bring Your Own Backend** — One line of middleware to monetize any API.
- **🔐 Privy server wallets** — No seed phrases. Instant wallet creation for agents. Automatic fee sponsorship.
- **⛓️ Built on Tempo** — ~2s finality, fee sponsorship, pathUSD stablecoin payments.
- **🤖 Agent-native** — No API keys, no accounts. Just a wallet and pathUSD.
- **🔍 Discoverable** — `.well-known/x-agentgate.json` lets agents find and price services automatically.
- **💸 Micro-payments** — Pay $0.005 for LLM inference. No minimums.

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

## Architecture — Two-Sided Marketplace

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   API Providers  │     │      AgentGate        │     │    AI Agents    │
│                  │     │                        │     │                 │
│ • LLM inference  │────▶│ • Service discovery    │◀────│ • Auto-discover │
│ • Data APIs      │     │ • Payment verification │     │ • Auto-pay 402  │
│ • Compute        │     │ • Provider registry    │     │ • Privy wallets │
│ • Any HTTP API   │     │ • Revenue tracking     │     │ • SDK client    │
│                  │     │                        │     │                 │
│ paywall()        │     │   Tempo Blockchain     │     │ AgentGateClient │
│ middleware       │     │   pathUSD stablecoins   │     │                 │
└─────────────────┘     └──────────────────────┘     └─────────────────┘
```

## Provider Registration

Providers can register their APIs on the AgentGate marketplace:

```bash
# Register a new service
curl -X POST https://gateway-production-aa5c.up.railway.app/api/providers/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My LLM API",
    "endpoint": "https://my-api.com/inference",
    "price": "0.01",
    "description": "GPT-4 proxy with function calling",
    "category": "inference",
    "walletAddress": "0xYourWallet"
  }'

# List all registered providers
curl https://gateway-production-aa5c.up.railway.app/api/providers
```

Or use the web UI at [`/providers`](https://gateway-production-aa5c.up.railway.app/providers).

## Project Structure

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

# Gateway runs on https://tempo-agentgategateway-production.up.railway.app
# Dashboard at https://tempo-agentgategateway-production.up.railway.app/dashboard
```

## Services

| Endpoint | Price | Description |
|----------|-------|-------------|
| `POST /api/chat` | 0.005 pathUSD | ⭐ **LLM Chat** — Groq-powered llama-3.3-70b inference |
| `POST /api/execute` | 0.01 pathUSD | Code Execution — TypeScript, Python, or shell |
| `POST /api/scrape` | 0.005 pathUSD | Web Scraping — fetch and extract content |
| `POST /api/deploy` | 0.05 pathUSD | Site Deployment — deploy HTML to a live URL |

**Free endpoints:** `/`, `/dashboard`, `/providers`, `/api/health`, `/api/sites`, `/api/providers`, `/.well-known/x-agentgate.json`

## SDK Usage (Agent Side)

```typescript
import { AgentGateClient } from '@tempo-agentgate/sdk';

const agent = new AgentGateClient({
  privateKey: '0x...',  // Agent's private key (funded with pathUSD)
});

// Discover available services
const services = await agent.discover('https://tempo-agentgategateway-production.up.railway.app');

// Call a paid endpoint — payment is automatic!
const res = await agent.fetch('https://tempo-agentgategateway-production.up.railway.app/api/execute', {
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

### Privy Server Wallets (Managed Mode)

Instead of managing raw private keys, agents can use [Privy server wallets](https://docs.privy.io/guide/server-wallets/) for delegated key management with built-in fee sponsorship:

```typescript
import { AgentGateClient } from '@tempo-agentgate/sdk';

const agent = new AgentGateClient({
  privyAppId: 'your-privy-app-id',
  privyAppSecret: 'your-privy-app-secret',
  walletId: 'wallet-id-from-privy',
});

// Resolve the wallet address (required once for Privy wallets)
await agent.resolveAddress();

// Everything else works the same — payments use Privy's API
// with automatic fee sponsorship (no gas tokens needed!)
const res = await agent.fetch('https://tempo-agentgategateway-production.up.railway.app/api/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: 'console.log("hello")', language: 'typescript' }),
});
```

**Provision a new wallet via the gateway:**

```bash
curl -X POST https://tempo-agentgategateway-production.up.railway.app/api/wallets/create
# Returns: { "walletId": "...", "address": "0x..." }

# Check balance:
curl https://tempo-agentgategateway-production.up.railway.app/api/wallets/<walletId>/balance
```

### Fee Sponsorship

Tempo supports fee sponsorship where a third party pays gas on behalf of the sender. This means agents don't need to hold any native gas tokens — only pathUSD.

- **Privy wallets:** Fee sponsorship is automatic (`sponsor: true` is sent with every transaction).
- **Raw private keys:** Use Tempo's native `withFeePayer` transport or provide a `feePayerPrivateKey` in the config. See the [Tempo docs on fee sponsorship](https://docs.tempo.xyz) for details.

### Passkey Support

Tempo supports [WebAuthn passkeys](https://webauthn.guide/) for user authentication. In the AgentGate context:

- **Agents** use server wallets (Privy or raw keys) — passkeys don't apply.
- **Providers** (humans running gateways) can authenticate to the dashboard using Tempo's native passkey accounts. This enables passwordless login for managing gateway settings, viewing transactions, and monitoring services.

Passkey integration uses Tempo's built-in account abstraction. Providers who create a Tempo account with a passkey can sign transactions directly from the browser without managing seed phrases.

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
curl https://tempo-agentgategateway-production.up.railway.app/.well-known/x-agentgate.json
```

## Tempo-Native Features

AgentGate leverages several features unique to Tempo that aren't available on Ethereum or other EVM chains:

### 🔐 Passkey Accounts
Tempo supports **P256/WebAuthn signatures natively at the protocol level**. Providers can authenticate to the AgentGate dashboard using Face ID, Touch ID, or security keys — no seed phrases or browser extensions needed. The passkey's P256 public key directly maps to a Tempo account.

→ [Tempo Passkey Docs](https://docs.tempo.xyz/guide/use-accounts/embed-passkeys)

### ⚡ Parallel Payments (2D Nonces)
On Ethereum, nonces are sequential — you must wait for tx #1 to confirm before sending tx #2. Tempo uses a **2D nonce system with expiring nonces**, allowing multiple transactions to be submitted concurrently. The SDK's `fetchMany()` method exploits this to send all payments in parallel, dramatically reducing latency for multi-service workflows.

### 📦 Batch Transactions
Tempo supports **atomic batch transactions** — multiple contract calls bundled into a single transaction. The SDK's `fetchBatch()` method uses this to pay for multiple API calls atomically: either all payments succeed or none do. This is critical for agent workflows that depend on multiple services.

→ [Tempo Batch Transactions Docs](https://docs.tempo.xyz/guide/use-accounts/batch-transactions)

### 🏷️ Transfer Memos
Tempo supports on-chain transfer memos, allowing agents to attach a **request fingerprint** (hash of the API request) to each payment. This enables providers to reconcile payments with specific API calls entirely on-chain.

### 💸 Fee Sponsorship
Tempo's native fee sponsorship means **agents pay zero gas fees**. A sponsor (the gateway operator or Privy) covers all transaction costs. Agents only need pathUSD stablecoins — no native gas tokens required.

### 🔑 Native Account Abstraction
Tempo has built-in smart accounts with session keys and spending limits, enabling fine-grained control over agent wallets without deploying custom smart contracts.

## Chain Details

- **Network:** Tempo Testnet (Moderato)
- **Chain ID:** 42431
- **RPC:** `https://rpc.moderato.tempo.xyz`
- **Explorer:** `https://explore.tempo.xyz`
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
