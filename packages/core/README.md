# @agentgate/core

Core types, chain definitions, token addresses, and payment verification for **AgentGate** — the HTTP 402 payment protocol for AI agents on [Tempo](https://tempo.xyz).

## Install

```bash
npm install @agentgate/core viem
```

## Usage

```typescript
import {
  tempoTestnet,
  STABLECOINS,
  verifyPayment,
  buildPaymentRequirement,
  ERC20_ABI,
} from '@agentgate/core';

// Build a 402 payment requirement
const requirement = buildPaymentRequirement({
  recipientAddress: '0x...',
  token: 'pathUSD',
  amount: '0.01',
  endpoint: 'GET /api/data',
  nonce: crypto.randomUUID(),
  expiry: Math.floor(Date.now() / 1000) + 300,
  chainId: tempoTestnet.id,
});

// Verify an on-chain payment
const result = await verifyPayment({
  txHash: '0x...',
  requirement,
});
```

## License

MIT
