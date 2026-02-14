import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { paywall } from '../../packages/middleware/src/index';

const RECIPIENT = '0x00DfEe79B7fd7aEF0312E06da8E1d60a5957F9Cf' as const;

function createTestApp() {
  const app = new Hono();

  app.use(
    '/api/*',
    paywall({
      recipientAddress: RECIPIENT,
      token: 'pathUSD',
      pricing: {
        'POST /api/paid': { amount: '0.01', description: 'Paid endpoint' },
      },
    }),
  );

  app.post('/api/paid', (c) => c.json({ result: 'success' }));
  app.get('/api/free', (c) => c.json({ result: 'free content' }));
  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}

describe('paywall middleware', () => {
  test('returns 402 for paid endpoint without payment', async () => {
    const app = createTestApp();
    const res = await app.request('/api/paid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(402);

    const body = await res.json();
    expect(body.error).toBe('Payment Required');
    expect(body.payment).toBeDefined();
    expect(body.payment.recipientAddress).toBe(RECIPIENT);
    expect(body.payment.tokenSymbol).toBe('pathUSD');
    expect(body.payment.amountRequired).toBe('10000');
    expect(body.instructions).toBeDefined();
    expect(body.instructions.steps).toHaveLength(3);
  });

  test('free endpoint (no pricing match) passes through', async () => {
    const app = createTestApp();
    const res = await app.request('/api/free', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe('free content');
  });

  test('non-api endpoint bypasses paywall entirely', async () => {
    const app = createTestApp();
    const res = await app.request('/health', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('returns 400 for invalid X-Payment header (no colon)', async () => {
    const app = createTestApp();
    const res = await app.request('/api/paid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': 'invalidheader',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid');
  });

  test('returns 400 for X-Payment without 0x prefix', async () => {
    const app = createTestApp();
    const res = await app.request('/api/paid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': 'nothex:42431',
      },
    });
    expect(res.status).toBe(400);
  });

  test('replay protection: same tx hash rejected', async () => {
    const usedTxHashes = new Set<string>();
    const app = new Hono();
    app.use(
      '/api/*',
      paywall({
        recipientAddress: RECIPIENT,
        token: 'pathUSD',
        pricing: { 'POST /api/test': { amount: '0.01' } },
        usedTxHashes,
      }),
    );
    app.post('/api/test', (c) => c.json({ ok: true }));

    // Simulate a used tx hash
    usedTxHashes.add('0xdeadbeef');

    const res = await app.request('/api/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': '0xdeadbeef:42431',
      },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('already used');
  });

  test('402 response includes correct payment amounts', async () => {
    const app = new Hono();
    app.use(
      '/api/*',
      paywall({
        recipientAddress: RECIPIENT,
        token: 'pathUSD',
        pricing: {
          'POST /api/cheap': { amount: '0.001', description: 'Cheap' },
          'POST /api/expensive': { amount: '10.00', description: 'Expensive' },
        },
      }),
    );
    app.post('/api/cheap', (c) => c.json({}));
    app.post('/api/expensive', (c) => c.json({}));

    const cheapRes = await app.request('/api/cheap', { method: 'POST' });
    const cheapBody = await cheapRes.json();
    expect(cheapBody.payment.amountRequired).toBe('1000'); // 0.001 * 10^6

    const expensiveRes = await app.request('/api/expensive', { method: 'POST' });
    const expensiveBody = await expensiveRes.json();
    expect(expensiveBody.payment.amountRequired).toBe('10000000'); // 10 * 10^6
  });
});
