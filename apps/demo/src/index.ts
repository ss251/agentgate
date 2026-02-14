import { Hono } from 'hono';
import { paywall } from '@agentgate/middleware';
import { TOKENS } from '@agentgate/core';

const WALLET = (process.env.PROVIDER_WALLET ?? '0x0000000000000000000000000000000000000001') as `0x${string}`;

const app = new Hono();

// Apply payment middleware
app.use(
  '/*',
  paywall({
    wallet: WALLET,
    token: TOKENS.pathUSD,
    serviceName: 'AgentGate Demo',
    serviceDescription: 'Demo API services with on-chain payments on Tempo',
    routes: {
      'POST /api/echo': {
        price: '0.001',
        description: 'Echo service — returns your input',
      },
      'GET /api/weather': {
        price: '0.001',
        description: 'Weather data for any city',
      },
      'POST /api/inference': {
        price: '0.01',
        description: 'LLM inference',
      },
    },
  }),
);

// Echo endpoint
app.post('/api/echo', async (c) => {
  const body = await c.req.json();
  return c.json({ echo: body, timestamp: Date.now() });
});

// Weather endpoint (mock data)
app.get('/api/weather', (c) => {
  const city = c.req.query('city') ?? 'unknown';
  const mockWeather: Record<string, any> = {
    tokyo: { temp: 15, condition: 'Partly Cloudy', humidity: 62 },
    london: { temp: 8, condition: 'Rainy', humidity: 85 },
    'new york': { temp: 12, condition: 'Sunny', humidity: 45 },
    mumbai: { temp: 32, condition: 'Humid', humidity: 78 },
  };

  const weather = mockWeather[city.toLowerCase()] ?? {
    temp: Math.floor(Math.random() * 35),
    condition: 'Unknown',
    humidity: Math.floor(Math.random() * 100),
  };

  return c.json({ city, ...weather, unit: 'celsius', source: 'agentgate-demo' });
});

// Inference endpoint
app.post('/api/inference', async (c) => {
  const { prompt } = await c.req.json();

  // Use OpenAI if key is available, otherwise mock
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 256,
        }),
      });
      const data = await res.json();
      return c.json({
        response: data.choices?.[0]?.message?.content ?? 'No response',
        model: 'gpt-4o-mini',
        source: 'openai',
      });
    } catch {
      // Fall through to mock
    }
  }

  // Mock response
  return c.json({
    response: `This is a mock inference response to: "${prompt}". In production, this would call a real LLM.`,
    model: 'mock-v1',
    source: 'agentgate-demo',
  });
});

// Health check (free)
app.get('/', (c) => {
  return c.json({
    name: 'AgentGate Demo',
    version: '0.1.0',
    status: 'running',
    discovery: '/.well-known/agentgate.json',
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🚀 AgentGate Demo running on http://localhost:${port}`);
console.log(`📋 Service discovery: http://localhost:${port}/.well-known/agentgate.json`);

export default {
  port,
  fetch: app.fetch,
};
