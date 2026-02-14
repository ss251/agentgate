# AgentGate — AI Agent Payment Gateway on Tempo

## 🎯 Elevator Pitch
A marketplace where AI agents pay for API endpoints, inference, website deployments, and other services using stablecoins on Tempo — with a single HTTP request. Service providers register endpoints, set prices, and get paid instantly. Built on x402 (HTTP 402 Payment Required) protocol adapted for Tempo's stablecoin rails.

## 📐 Architecture

### Why This Wins
- **Track 3: AI Agents & Automation** — directly targets "Agent-to-Agent Commerce", "Pay-per-API-Call", "Microtransactions"
- Also touches Track 2 (Stablecoin Infrastructure) via service marketplace
- Uses Tempo's killer features: instant finality, fee sponsorship, transfer memos, no native token needed
- x402 is the perfect protocol for this — HTTP-native payments, zero accounts needed

### x402 + Tempo Compatibility
**x402 does NOT natively support Tempo yet** (only EVM chains like Base/Ethereum and Solana). However:
- Tempo is EVM-compatible (chain ID 42431, RPC: `https://rpc.moderato.tempo.xyz`)
- x402's `exact` scheme works on EVM chains
- We can either: (a) fork `@x402/evm` to add Tempo chain support, or (b) build our own x402-inspired middleware that uses Tempo's native TIP-20 transfers directly
- **Recommendation: Build our own lightweight x402-compatible middleware** using Tempo's TypeScript SDK (viem + wagmi) — this showcases deeper Tempo integration and avoids dependency on x402's facilitator infrastructure

### System Components

```
┌─────────────┐    HTTP 402     ┌──────────────────┐    TIP-20 Transfer    ┌─────────────┐
│  AI Agent   │ ──────────────► │   AgentGate API  │ ◄──────────────────►  │   Tempo     │
│  (Client)   │ ◄────────────── │   (Hono + Bun)   │                       │  Blockchain │
└─────────────┘   Resource      └──────────────────┘                       └─────────────┘
                                       │
                                       │ Proxy/Gateway
                                       ▼
                               ┌──────────────────┐
                               │  Service Provider │
                               │  Endpoints        │
                               │  (AWS Lambda,     │
                               │   APIs, LLMs,     │
                               │   Vercel Deploy)  │
                               └──────────────────┘
```

### Tech Stack
- **Runtime**: Bun
- **API Framework**: Hono
- **Blockchain**: Tempo Testnet (chain ID 42431)
- **Auth/Wallets**: Privy (server wallets for agents, embedded wallets for providers)
- **Infra**: AWS (Lambda for service endpoints, DynamoDB for registry, S3 for deployments)
- **Payments**: TIP-20 stablecoin transfers (pathUSD on testnet) via Tempo TypeScript SDK
- **Frontend**: Next.js or simple Hono SSR for provider dashboard

## 🏗️ Core Features (MVP — 30 hours)

### 1. Payment Middleware (x402-style)
```typescript
// Server-side: Hono middleware
app.use('/api/*', tempoPaymentMiddleware({
  wallet: PROVIDER_WALLET,
  token: PATHUSD_ADDRESS,
  pricing: {
    'POST /api/inference': { amount: '0.01', description: 'LLM inference' },
    'POST /api/deploy': { amount: '1.00', description: 'Deploy website' },
    'GET /api/weather': { amount: '0.001', description: 'Weather data' },
  }
}));
```

**Flow:**
1. Agent sends request without payment → gets `402 Payment Required` with payment details
2. Agent signs a TIP-20 transfer to provider's wallet (amount + memo with request hash)
3. Agent retries request with `X-Payment-Tx` header containing tx hash
4. Middleware verifies tx on Tempo (instant finality = instant verification)
5. Request is proxied to the actual service endpoint

### 2. Service Registry
Providers register their endpoints:
```
POST /registry/services
{
  "name": "GPT-4 Inference",
  "endpoint": "https://my-api.com/inference",
  "price_per_call": "0.01",  // in pathUSD
  "description": "OpenAI GPT-4 proxy",
  "category": "inference"
}
```

### 3. Agent SDK (Client)
```typescript
import { AgentGateClient } from '@agentgate/sdk';

const agent = new AgentGateClient({
  privyAppId: '...',
  walletId: '...', // Privy server wallet
});

// Automatic payment handling
const result = await agent.call('https://agentgate.xyz/api/inference', {
  method: 'POST',
  body: { prompt: 'Hello world' }
});
// SDK handles: 402 → sign payment → retry → return result
```

### 4. Provider Dashboard (Web)
- Register/manage services
- View earnings, transaction history
- Set pricing per endpoint
- Analytics (calls, revenue, top agents)

### 5. Demo Services (AWS)
Pre-built services to demonstrate the platform:
- **LLM Proxy**: Pay-per-call OpenAI/Anthropic inference
- **Weather API**: Microtransaction weather data
- **Website Deployer**: Pay to deploy a static site to S3+CloudFront

## 📁 Project Structure

```
tempo-hackathon/
├── packages/
│   ├── core/           # Payment types, verification logic
│   ├── middleware/      # Hono payment middleware
│   ├── sdk/            # Agent client SDK
│   └── contracts/      # Any Solidity if needed (optional)
├── apps/
│   ├── gateway/        # Main Hono API server (Bun)
│   ├── dashboard/      # Provider dashboard (Next.js or Hono SSR)
│   └── demo-services/  # Sample AWS Lambda services
├── PLAN.md
├── LINKS.md
└── README.md
```

## ⏱️ Timeline (30 hours)

### Phase 1: Foundation (Hours 0-8)
- [ ] Set up monorepo with Bun workspaces
- [ ] Connect to Tempo testnet, get faucet tokens (pathUSD)
- [ ] Set up Privy for server wallet creation
- [ ] Build core payment verification logic (check TIP-20 transfer on Tempo)
- [ ] Build Hono payment middleware (402 → verify → proxy)

### Phase 2: Gateway + Registry (Hours 8-16)
- [ ] Service registry (DynamoDB or SQLite for hackathon)
- [ ] Gateway that routes paid requests to registered services
- [ ] Agent SDK with auto-pay flow
- [ ] Deploy 2-3 demo services on AWS Lambda

### Phase 3: Dashboard + Polish (Hours 16-24)
- [ ] Provider dashboard (register services, view earnings)
- [ ] Agent wallet management via Privy
- [ ] Transfer memos for request tracking/reconciliation
- [ ] Fee sponsorship for onboarding (first N calls free)

### Phase 4: Demo + Submission (Hours 24-30)
- [ ] End-to-end demo: agent pays for inference + deployment
- [ ] README, demo video
- [ ] Deploy to production URL
- [ ] Submit via Tally form

## 🔑 Key Technical Decisions

### Why NOT use x402 directly?
- x402 doesn't support Tempo chain natively
- x402 requires a separate "facilitator" server — adds complexity
- Building our own is more impressive for hackathon judges (deeper Tempo integration)
- We still follow x402's HTTP 402 pattern — making it compatible/interoperable

### Why Privy?
- Server wallets for AI agents (no seed phrase management)
- Track 1 requires Privy, and using it in Track 3 shows versatility
- API-driven wallet creation = perfect for programmatic agent onboarding

### Why Hono + Bun?
- Ultra-fast (important for payment middleware in the hot path)
- x402 already has `@x402/hono` — shows ecosystem alignment
- Lighter than Express, better DX than raw Node

## 🔗 Tempo Testnet Details
- **Chain ID**: 42431
- **RPC**: `https://rpc.moderato.tempo.xyz`
- **Explorer**: `https://explorer.moderato.tempo.xyz`
- **Faucet**: `https://faucet.tempo.xyz`
- **Stablecoins**: pathUSD, AlphaUSD, BetaUSD, ThetaUSD
- **Fee token**: Any TIP-20 stablecoin (no native gas token!)
- **TypeScript SDK**: `@tempo-xyz/tempo-ts` (viem/wagmi extensions)

## 🏆 Judging Alignment

| Criteria (Weight) | How We Score |
|---|---|
| Technical Implementation (30%) | Custom payment middleware, Tempo SDK integration, Privy server wallets, AWS services |
| Innovation (25%) | First x402-style payment gateway on Tempo; agent-to-service commerce marketplace |
| User Experience (20%) | One-line middleware for providers; auto-pay SDK for agents; clean dashboard |
| Ecosystem Impact (15%) | Enables any service to be monetized by AI agents on Tempo; open marketplace |
| Presentation (10%) | Live demo: agent pays for inference → gets result in real-time |
