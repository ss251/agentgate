# @tempo-agentgate/sdk

SDK for AI agents to auto-pay HTTP 402 APIs with on-chain TIP-20 transfers on [Tempo](https://tempo.xyz).

## Install

```bash
npm install @tempo-agentgate/sdk @tempo-agentgate/core viem
```

## Usage

```typescript
import { AgentGateClient } from '@tempo-agentgate/sdk';

const client = new AgentGateClient({
  privateKey: '0xYourPrivateKey',
});

// Automatically handles 402 → pay → retry
const response = await client.fetch('https://api.example.com/data');
const data = await response.json();

// Check balance
const balance = await client.getBalance('pathUSD');

// Discover available services
const services = await client.discover('https://api.example.com');
```

## License

MIT
