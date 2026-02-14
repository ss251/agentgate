import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { AgentGateClient } from '../packages/sdk/src/index';

const GATEWAY_URL = 'http://localhost:3402';
const AGENT_PRIVATE_KEY = '0x4afc13e37cdba626e6075f85b82d23e9ba66c73faa7b3af920ad6da320a8ecfb' as const;

let gateway: any;
let client: AgentGateClient;

beforeAll(async () => {
  gateway = Bun.spawn(['bun', 'run', 'apps/gateway/src/index.ts'], {
    cwd: import.meta.dir + '/..',
    env: { ...process.env, PORT: '3402' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(GATEWAY_URL);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  client = new AgentGateClient({ privateKey: AGENT_PRIVATE_KEY });
});

afterAll(() => {
  gateway?.kill();
});

// ─── Service Discovery ──────────────────────────────────────────
describe('Service Discovery', () => {
  test('GET /.well-known/x-agentgate.json returns service info', async () => {
    const res = await fetch(`${GATEWAY_URL}/.well-known/x-agentgate.json`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('AgentGate Gateway');
    expect(data.endpoints.length).toBeGreaterThanOrEqual(3);
    expect(data.token.decimals).toBe(6);
    expect(data.chain.id).toBe(42431);
  });

  test('discover() works via SDK', async () => {
    const info = await client.discover(GATEWAY_URL);
    expect(info.endpoints.length).toBeGreaterThan(0);
  });
});

// ─── Free Endpoints ──────────────────────────────────────────────
describe('Free Endpoints', () => {
  test('GET / returns gateway info without payment', async () => {
    const res = await fetch(GATEWAY_URL, {
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.service).toBe('AgentGate Gateway');
    expect(data.free).toBeDefined();
  });

  test('GET /api/health returns health status', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.uptime).toBeGreaterThanOrEqual(0);
  });

  test('GET /api/sites returns sites list', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/sites`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sites).toBeDefined();
    expect(typeof data.count).toBe('number');
  });

  test('GET /dashboard returns HTML', async () => {
    const res = await fetch(`${GATEWAY_URL}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('AgentGate Dashboard');
  });

  test('responses include X-Request-Id header', async () => {
    const res = await fetch(GATEWAY_URL);
    expect(res.headers.get('X-Request-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// ─── 402 Payment Required ────────────────────────────────────────
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
    expect(data.payment.amountRequired).toBe('10000');
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
    expect(data.payment.amountRequired).toBe('5000');
  });

  test('POST /api/deploy without payment returns 402', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<h1>Hi</h1>' }),
    });
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.payment.amountRequired).toBe('50000');
  });

  test('invalid X-Payment format returns 400', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': 'not-a-valid-header',
      },
      body: JSON.stringify({ code: 'console.log(1)' }),
    });
    expect(res.status).toBe(400);
  });

  test('X-Payment with fake tx hash fails verification', async () => {
    const fakeTx = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const res = await fetch(`${GATEWAY_URL}/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': `${fakeTx}:42431`,
      },
      body: JSON.stringify({ code: 'console.log(1)' }),
    });
    // Should fail verification (402 with error details)
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.error).toContain('verification failed');
  });
});

// ─── E2E: Pay and Use Services ───────────────────────────────────
describe('E2E: Pay and Use Services', () => {
  test(
    'Code Execution — TypeScript',
    async () => {
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
    },
    30000,
  );

  test(
    'Code Execution — Shell',
    async () => {
      const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'echo hello world', language: 'shell' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.stdout.trim()).toBe('hello world');
      expect(data.exitCode).toBe(0);
    },
    30000,
  );

  test(
    'Code Execution — syntax error returns non-zero exit',
    async () => {
      const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'const x = {{{', language: 'typescript' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.exitCode).not.toBe(0);
      expect(data.stderr.length).toBeGreaterThan(0);
    },
    30000,
  );

  test(
    'Web Scraping — example.com',
    async () => {
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
    },
    30000,
  );

  test(
    'Site Deployment — deploy and fetch',
    async () => {
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

      const siteRes = await fetch(data.url);
      expect(siteRes.status).toBe(200);
      const siteHtml = await siteRes.text();
      expect(siteHtml).toContain('Hello from AgentGate!');
    },
    30000,
  );
});

// ─── Edge Cases: Code Execution ──────────────────────────────────
describe('Edge Cases: Code Execution', () => {
  test(
    'rejects code exceeding max length',
    async () => {
      const longCode = 'x'.repeat(11 * 1024); // >10KB
      const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: longCode, language: 'typescript' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('CODE_TOO_LARGE');
    },
    30000,
  );

  test(
    'blocks dangerous shell commands',
    async () => {
      const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'rm -rf /', language: 'shell' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('BLOCKED_COMMAND');
    },
    30000,
  );

  test(
    'unsupported language returns 400',
    async () => {
      const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'puts "hi"', language: 'ruby' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('UNSUPPORTED_LANGUAGE');
    },
    30000,
  );

  test(
    'missing code field returns 400',
    async () => {
      const res = await client.fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'typescript' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('MISSING_CODE');
    },
    30000,
  );
});

// ─── Edge Cases: Scrape ──────────────────────────────────────────
describe('Edge Cases: Scrape', () => {
  test(
    'rejects invalid URL',
    async () => {
      const res = await client.fetch(`${GATEWAY_URL}/api/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('INVALID_URL');
    },
    30000,
  );

  test(
    'missing url field returns 400',
    async () => {
      const res = await client.fetch(`${GATEWAY_URL}/api/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('MISSING_URL');
    },
    30000,
  );
});

// ─── Edge Cases: Deploy ──────────────────────────────────────────
describe('Edge Cases: Deploy', () => {
  test(
    'rejects empty HTML',
    async () => {
      const res = await client.fetch(`${GATEWAY_URL}/api/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: '   ' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('EMPTY_HTML');
    },
    30000,
  );

  test(
    'rejects oversized HTML',
    async () => {
      const hugeHtml = '<p>' + 'x'.repeat(1024 * 1024 + 100) + '</p>';
      const res = await client.fetch(`${GATEWAY_URL}/api/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: hugeHtml }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('HTML_TOO_LARGE');
    },
    30000,
  );
});

// ─── Replay Protection ──────────────────────────────────────────
describe('Replay Protection', () => {
  test(
    'Same tx hash cannot be used twice',
    async () => {
      const res1 = await fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'console.log("first")', language: 'typescript' }),
      });
      expect(res1.status).toBe(402);
      const { payment } = await res1.json();

      const txHash = await client.sendPayment({
        to: payment.recipientAddress,
        tokenAddress: payment.tokenAddress,
        amount: BigInt(payment.amountRequired),
      });

      const res2 = await fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment': `${txHash}:42431`,
        },
        body: JSON.stringify({ code: 'console.log("first")', language: 'typescript' }),
      });
      expect(res2.status).toBe(200);

      const res3 = await fetch(`${GATEWAY_URL}/api/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment': `${txHash}:42431`,
        },
        body: JSON.stringify({ code: 'console.log("second")', language: 'typescript' }),
      });
      expect(res3.status).toBe(409);
    },
    30000,
  );
});
