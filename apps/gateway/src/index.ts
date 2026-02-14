import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { paywall } from '@agentgate/middleware';
import { STABLECOINS } from '@agentgate/core';
import type { Address } from 'viem';

// ─── Config ──────────────────────────────────────────────────────
const PROVIDER_ADDRESS = (process.env.PROVIDER_ADDRESS ?? '0x0000000000000000000000000000000000000000') as Address;
const PORT = parseInt(process.env.PORT ?? '3402', 10);

// ─── App ─────────────────────────────────────────────────────────
const app = new Hono();

app.use('*', cors());
app.use('*', logger());

// ─── Service Discovery ──────────────────────────────────────────
app.get('/.well-known/x-agentgate.json', (c) =>
  c.json({
    name: 'AgentGate Demo Gateway',
    version: '0.1.0',
    chain: { id: 42431, name: 'Tempo Testnet' },
    token: { symbol: 'pathUSD', address: STABLECOINS.pathUSD.address },
    recipient: PROVIDER_ADDRESS,
    endpoints: [
      { method: 'POST', path: '/api/chat', price: '0.01', description: 'LLM Chat Completion' },
      { method: 'GET', path: '/api/weather', price: '0.001', description: 'Weather Data' },
      { method: 'POST', path: '/api/summarize', price: '0.005', description: 'Text Summarization' },
    ],
  })
);

// ─── Paywall Middleware ──────────────────────────────────────────
app.use(
  '/api/*',
  paywall({
    recipientAddress: PROVIDER_ADDRESS,
    token: 'pathUSD',
    pricing: {
      'POST /api/chat': { amount: '0.01', description: 'LLM Chat Completion' },
      'GET /api/weather': { amount: '0.001', description: 'Weather Data' },
      'POST /api/summarize': { amount: '0.005', description: 'Text Summarization' },
    },
    onPayment: async ({ from, amount, txHash, endpoint }) => {
      console.log(`💰 Payment received: ${amount} from ${from} for ${endpoint} (tx: ${txHash})`);
    },
  })
);

// ─── Demo Endpoints (behind paywall) ────────────────────────────

app.post('/api/chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prompt = body.prompt ?? body.message ?? 'Hello';
  // Mock LLM response (replace with real OpenAI/Anthropic call)
  return c.json({
    response: `This is a paid AI response to: "${prompt}". In production, this would call an actual LLM.`,
    model: 'agentgate-demo-v1',
    usage: { prompt_tokens: prompt.length, completion_tokens: 42 },
  });
});

app.get('/api/weather', (c) => {
  const city = c.req.query('city') ?? 'Bangkok';
  return c.json({
    city,
    temperature: 32,
    unit: 'celsius',
    condition: 'Partly Cloudy',
    humidity: 65,
    source: 'agentgate-weather-demo',
  });
});

app.post('/api/summarize', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = body.text ?? '';
  return c.json({
    summary: `Summary of ${text.length} chars: ${text.slice(0, 100)}...`,
    word_count: text.split(/\s+/).length,
  });
});

// ─── Health + Info ───────────────────────────────────────────────
app.get('/', (c) =>
  c.json({
    service: 'AgentGate Demo Gateway',
    version: '0.1.0',
    docs: '/.well-known/x-agentgate.json',
    endpoints: {
      'POST /api/chat': '0.01 pathUSD — LLM Chat',
      'GET /api/weather': '0.001 pathUSD — Weather',
      'POST /api/summarize': '0.005 pathUSD — Summarize',
    },
  })
);

// ─── Start ───────────────────────────────────────────────────────
console.log(`🚀 AgentGate Gateway running on http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
