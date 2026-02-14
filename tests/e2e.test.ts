import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { AgentGateClient } from '../packages/sdk/src/index';

const GATEWAY_URL = 'http://localhost:3402';
const AGENT_PRIVATE_KEY = '0x4afc13e37cdba626e6075f85b82d23e9ba66c73faa7b3af920ad6da320a8ecfb' as const;

let gateway: any;
let client: AgentGateClient;

beforeAll(async () => {
  // Start gateway
  gateway = Bun.spawn(['bun', 'run', 'apps/gateway/src/index.ts'], {
    cwd: import.meta.dir + '/..',
    env: { ...process.env, PORT: '3402' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Wait for it to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(GATEWAY_URL);
      if (res.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  client = new AgentGateClient({
    privateKey: AGENT_PRIVATE_KEY,
  });
});

afterAll(() => {
  gateway?.kill();
});

describe('Service Discovery', () => {
  test('GET /.well-known/x-agentgate.json returns service info', async () => {
    const res = await fetch(`${GATEWAY_URL}/.well-known/x-agentgate.json`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('AgentGate Gateway');
    expect(data.endpoints).toHaveLength(3);
    expect(data.token.decimals).toBe(6);
    expect(data.chain.id).toBe(42431);
  });

  test('discover() works via SDK', async () => {
    const info = await client.discover(GATEWAY_URL);
    expect(info.endpoints.length).toBeGreaterThan(0);
  });
});

describe('402 Payment Required', () => {
  test('POST /api/execute without payment returns 402', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'console.log("hi")', language: 'typescript' }),
    });
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.payment).toBeDefined();
    expect(data.payment.amountRequired).toBe('10000'); // 0.01 * 10^6
    expect(data.payment.tokenSymbol).toBe('pathUSD');
  });

  test('POST /api/scrape without payment returns 402', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.payment.amountRequired).toBe('5000'); // 0.005 * 10^6
  });

  test('POST /api/deploy without payment returns 402', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<h1>Hi</h1>' }),
    });
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.payment.amountRequired).toBe('50000'); // 0.05 * 10^6
  });
});

describe('E2E: Pay and Use Services', () => {
  test('Code Execution — TypeScript', async () => {
    const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'console.log(2 + 2)', language: 'typescript' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.stdout.trim()).toBe('4');
    expect(data.exitCode).toBe(0);
    expect(data.executionTimeMs).toBeGreaterThan(0);
  }, 30000);

  test('Code Execution — Shell', async () => {
    const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'echo hello world', language: 'shell' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.stdout.trim()).toBe('hello world');
    expect(data.exitCode).toBe(0);
  }, 30000);

  test('Web Scraping — example.com', async () => {
    const res = await client.fetch(`${GATEWAY_URL}/api/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', format: 'text' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toContain('Example');
    expect(data.content.length).toBeGreaterThan(0);
    expect(data.wordCount).toBeGreaterThan(0);
    expect(data.fetchedAt).toBeDefined();
  }, 30000);

  test('Site Deployment — deploy and fetch', async () => {
    const html = '<h1>Hello from AgentGate!</h1><p>This site was deployed via paid API.</p>';
    const res = await client.fetch(`${GATEWAY_URL}/api/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, title: 'Test Deploy' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBeDefined();
    expect(data.deployId).toBeDefined();

    // Fetch the deployed site
    const siteRes = await fetch(data.url);
    expect(siteRes.status).toBe(200);
    const siteHtml = await siteRes.text();
    expect(siteHtml).toContain('Hello from AgentGate!');
  }, 30000);
});

describe('Replay Protection', () => {
  test('Same tx hash cannot be used twice', async () => {
    // First request — get 402 and pay
    const res1 = await fetch(`${GATEWAY_URL}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'console.log("first")', language: 'typescript' }),
    });
    expect(res1.status).toBe(402);
    const { payment } = await res1.json();

    // Send payment
    const txHash = await client.sendPayment({
      to: payment.recipientAddress,
      tokenAddress: payment.tokenAddress,
      amount: BigInt(payment.amountRequired),
    });

    // Use the tx hash
    const res2 = await fetch(`${GATEWAY_URL}/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': `${txHash}:42431`,
      },
      body: JSON.stringify({ code: 'console.log("first")', language: 'typescript' }),
    });
    expect(res2.status).toBe(200);

    // Try to reuse the same tx hash
    const res3 = await fetch(`${GATEWAY_URL}/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': `${txHash}:42431`,
      },
      body: JSON.stringify({ code: 'console.log("second")', language: 'typescript' }),
    });
    expect(res3.status).toBe(409);
  }, 30000);
});
