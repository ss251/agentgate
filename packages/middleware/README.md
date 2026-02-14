# @tempo-agentgate/middleware

Hono middleware that adds HTTP 402 paywall to API endpoints — verify on-chain TIP-20 payments on [Tempo](https://tempo.xyz).

## Install

```bash
npm install @tempo-agentgate/middleware @tempo-agentgate/core hono viem
```

## Usage

```typescript
import { Hono } from 'hono';
import { paywall } from '@tempo-agentgate/middleware';

const app = new Hono();

app.use('*', paywall({
  recipientAddress: '0xYourAddress',
  token: 'pathUSD',
  pricing: {
    'GET /api/data': { amount: '0.01', description: 'Fetch data' },
  },
}));

app.get('/api/data', (c) => c.json({ data: 'paid content' }));

export default app;
```

## License

MIT
