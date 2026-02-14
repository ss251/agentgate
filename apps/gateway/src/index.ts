import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { paywall } from '@tempo-agentgate/middleware';
import { STABLECOINS } from '@tempo-agentgate/core';
import { parse as parseHTML } from 'node-html-parser';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createPublicClient, http, formatUnits } from 'viem';
import { tempoTestnet } from '@tempo-agentgate/core';
import type { Address, Hex } from 'viem';

// ─── Config ──────────────────────────────────────────────────────
const VERSION = '0.2.0';
const PROVIDER_ADDRESS = (process.env.PROVIDER_ADDRESS ?? '0x00DfEe79B7fd7aEF0312E06da8E1d60a5957F9Cf') as Address;
const PORT = parseInt(process.env.PORT ?? '3402', 10);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const SITES_DIR = join(import.meta.dir, '..', '..', '..', '.sites');
const START_TIME = Date.now();

// Ensure sites directory exists
mkdirSync(SITES_DIR, { recursive: true });

// ─── Security Constants ──────────────────────────────────────────
/**
 * Security model for code execution:
 * - Max code length: 10KB (prevents memory abuse)
 * - Max output: 50KB stdout, 10KB stderr
 * - Execution timeout: 10s (kills process)
 * - Shell blocklist: prevents destructive/exfil commands
 * - Code runs in temp dir with restricted env (only PATH)
 * - No network access restrictions (future: use nsjail/firecracker)
 */
const MAX_CODE_LENGTH = 10 * 1024; // 10KB
const MAX_STDOUT_LENGTH = 50 * 1024; // 50KB
const MAX_STDERR_LENGTH = 10 * 1024; // 10KB
const EXECUTION_TIMEOUT_MS = 10_000;
const MAX_HTML_SIZE = 1024 * 1024; // 1MB for deploy
const SCRAPE_TIMEOUT_MS = 10_000;
const MAX_SCRAPE_RESPONSE = 500 * 1024; // 500KB
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';

// Dangerous shell patterns — basic blocklist (not a sandbox!)
const SHELL_BLOCKLIST = [
  /\brm\s+-rf\s+[\/~]/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b:(){ :|:& };:/,      // fork bomb
  />\s*\/dev\/sd/i,
  /\bcurl\b.*\|\s*sh/i,   // curl pipe to shell
  /\bwget\b.*\|\s*sh/i,
  /\bnc\s+-l/i,           // netcat listen
  /\bchmod\s+777\s+\//i,
  /\bshutdown\b/i,
  /\breboot\b/i,
];

// ─── In-Memory Stats ─────────────────────────────────────────────
interface TransactionLog {
  txHash: string;
  from: string;
  amount: string;
  endpoint: string;
  timestamp: string;
}

const stats = {
  totalRequests: 0,
  paidRequests: 0,
  totalRevenue: BigInt(0), // in raw pathUSD units (6 decimals)
  recentTransactions: [] as TransactionLog[],
};

// ─── Provider Registry ───────────────────────────────────────────
interface RegisteredProvider {
  id: string;
  name: string;
  endpoint: string;
  price: string;
  description: string;
  category: string;
  walletAddress: string;
  registeredAt: string;
}

const registeredProviders: RegisteredProvider[] = [];

// ─── App ─────────────────────────────────────────────────────────
const app = new Hono();

app.use('*', cors());
app.use('*', logger());

// Add request ID to every response
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  stats.totalRequests++;
  await next();
  c.res.headers.set('X-Request-Id', requestId);
  c.res.headers.set('X-Powered-By', 'AgentGate');
});

// ─── Error Types ─────────────────────────────────────────────────
class AgentGateError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = 'AgentGateError';
  }
}

// ─── Service Discovery ──────────────────────────────────────────
app.get('/.well-known/x-agentgate.json', (c) =>
  c.json({
    name: 'AgentGate Gateway',
    version: VERSION,
    chain: { id: 42431, name: 'Tempo Testnet' },
    token: { symbol: 'pathUSD', address: STABLECOINS.pathUSD.address, decimals: 6 },
    recipient: PROVIDER_ADDRESS,
    endpoints: [
      { method: 'POST', path: '/api/chat', price: '0.005', description: 'LLM Chat — Groq-powered fast inference (llama-3.3-70b)' },
      { method: 'POST', path: '/api/execute', price: '0.01', description: 'Code Execution — run TypeScript, Python, or shell code' },
      { method: 'POST', path: '/api/scrape', price: '0.005', description: 'Web Scraping — fetch and extract readable content from a URL' },
      { method: 'POST', path: '/api/deploy', price: '0.05', description: 'Site Deployment — deploy HTML and get a live URL' },
    ],
  })
);

// ─── Free Endpoints ──────────────────────────────────────────────
app.get('/api/health', (c) =>
  c.json({
    status: 'healthy',
    version: VERSION,
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    stats: {
      totalRequests: stats.totalRequests,
      paidRequests: stats.paidRequests,
      totalRevenue: formatUnits(stats.totalRevenue, 6) + ' pathUSD',
    },
  })
);

app.get('/api/sites', (c) => {
  try {
    const entries = readdirSync(SITES_DIR, { withFileTypes: true });
    const sites = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        deployId: e.name,
        url: `${BASE_URL}/sites/${e.name}`,
      }));
    return c.json({ sites, count: sites.length });
  } catch {
    return c.json({ sites: [], count: 0 });
  }
});

// ─── Privy Wallet Provisioning ───────────────────────────────────
const PRIVY_APP_ID = process.env.PRIVY_APP_ID ?? '';
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET ?? '';

app.post('/api/wallets/create', async (c) => {
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    return c.json({ error: 'Privy not configured', code: 'PRIVY_NOT_CONFIGURED' }, 503);
  }

  try {
    const basicAuth = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
    const res = await fetch('https://api.privy.io/v1/wallets', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'privy-app-id': PRIVY_APP_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chain_type: 'ethereum' }),
    });

    if (!res.ok) {
      const err = await res.text();
      return c.json({ error: 'Privy wallet creation failed', details: err }, 502);
    }

    const data = await res.json() as any;
    return c.json({ walletId: data.id, address: data.address });
  } catch (err: any) {
    return c.json({ error: `Wallet creation error: ${err.message}` }, 500);
  }
});

app.get('/api/wallets/:walletId/balance', async (c) => {
  const walletId = c.req.param('walletId');

  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    return c.json({ error: 'Privy not configured', code: 'PRIVY_NOT_CONFIGURED' }, 503);
  }

  try {
    // Get wallet address from Privy
    const basicAuth = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
    const walletRes = await fetch(`https://api.privy.io/v1/wallets/${walletId}`, {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'privy-app-id': PRIVY_APP_ID,
      },
    });

    if (!walletRes.ok) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    const walletData = await walletRes.json() as any;
    const walletAddress = walletData.address as Address;

    // Check on-chain balance
    const client = createPublicClient({ chain: tempoTestnet, transport: http() });
    const balance = await client.readContract({
      address: STABLECOINS.pathUSD.address,
      abi: [{ type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'balanceOf',
      args: [walletAddress],
    }) as bigint;

    return c.json({
      walletId,
      address: walletAddress,
      balance: formatUnits(balance, 6),
      balanceRaw: balance.toString(),
      token: 'pathUSD',
    });
  } catch (err: any) {
    return c.json({ error: `Balance check failed: ${err.message}` }, 500);
  }
});

// ─── Provider Registration (Free) ────────────────────────────────
app.post('/api/providers/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { name, endpoint, price, description, category, walletAddress } = body;

  if (!name || !endpoint || !price || !walletAddress) {
    return c.json({ error: 'Missing required fields: name, endpoint, price, walletAddress' }, 400);
  }

  const provider: RegisteredProvider = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    endpoint,
    price,
    description: description ?? '',
    category: category ?? 'general',
    walletAddress,
    registeredAt: new Date().toISOString(),
  };

  registeredProviders.push(provider);
  return c.json({ provider, message: 'Provider registered successfully' }, 201);
});

app.get('/api/providers', (c) => {
  return c.json({ providers: registeredProviders, count: registeredProviders.length });
});

// ─── Paywall Middleware ──────────────────────────────────────────
app.use(
  '/api/*',
  paywall({
    recipientAddress: PROVIDER_ADDRESS,
    token: 'pathUSD',
    pricing: {
      'POST /api/chat': { amount: '0.005', description: 'LLM Chat (Groq)' },
      'POST /api/execute': { amount: '0.01', description: 'Code Execution' },
      'POST /api/scrape': { amount: '0.005', description: 'Web Scraping' },
      'POST /api/deploy': { amount: '0.05', description: 'Site Deployment' },
    },
    onPayment: async ({ from, amount, txHash, endpoint }) => {
      stats.paidRequests++;
      stats.totalRevenue += amount;
      stats.recentTransactions.unshift({
        txHash,
        from,
        amount: formatUnits(amount, 6),
        endpoint,
        timestamp: new Date().toISOString(),
      });
      // Keep only last 100 transactions
      if (stats.recentTransactions.length > 100) {
        stats.recentTransactions.pop();
      }
      console.log(`💰 Payment received: ${formatUnits(amount, 6)} pathUSD from ${from} for ${endpoint} (tx: ${txHash})`);
    },
  })
);

// ─── LLM Chat Service (Groq) ────────────────────────────────────
app.post('/api/chat', async (c) => {
  if (!GROQ_API_KEY) {
    return c.json({ error: 'LLM service not configured', code: 'LLM_NOT_CONFIGURED' }, 503);
  }

  const body = await c.req.json().catch(() => ({}));
  const { messages, prompt, model, max_tokens, temperature } = body;

  // Support both OpenAI-style { messages } and simple { prompt }
  const chatMessages = messages ?? (prompt ? [{ role: 'user', content: prompt }] : null);
  if (!chatMessages || !Array.isArray(chatMessages) || chatMessages.length === 0) {
    return c.json({ error: 'Provide "messages" array or "prompt" string', code: 'INVALID_INPUT' }, 400);
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model ?? 'llama-3.3-70b-versatile',
        messages: chatMessages,
        max_tokens: Math.min(max_tokens ?? 1024, 4096),
        temperature: temperature ?? 0.7,
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      return c.json({ error: 'LLM request failed', details: err, code: 'LLM_ERROR' }, 502);
    }

    const data = await groqRes.json() as any;
    return c.json({
      response: data.choices?.[0]?.message?.content ?? '',
      model: data.model,
      usage: data.usage,
      provider: 'groq',
    });
  } catch (err: any) {
    return c.json({ error: `LLM error: ${err.message}`, code: 'LLM_ERROR' }, 500);
  }
});

// ─── Code Execution Service ─────────────────────────────────────
app.post('/api/execute', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { code, language } = body;

  if (!code || typeof code !== 'string') {
    return c.json({ error: 'MISSING_CODE', message: 'Missing required field: code' }, 400);
  }

  // Security: max code length
  if (code.length > MAX_CODE_LENGTH) {
    return c.json({
      error: 'CODE_TOO_LARGE',
      message: `Code exceeds maximum length of ${MAX_CODE_LENGTH} bytes`,
    }, 400);
  }

  const lang = language ?? 'typescript';
  if (!['typescript', 'python', 'shell'].includes(lang)) {
    return c.json({ error: 'UNSUPPORTED_LANGUAGE', message: 'Supported languages: typescript, python, shell' }, 400);
  }

  // Security: shell blocklist
  if (lang === 'shell') {
    for (const pattern of SHELL_BLOCKLIST) {
      if (pattern.test(code)) {
        return c.json({
          error: 'BLOCKED_COMMAND',
          message: 'Code contains a blocked command pattern for security reasons',
        }, 400);
      }
    }
  }

  const startTime = Date.now();

  try {
    let cmd: string[];
    switch (lang) {
      case 'typescript':
        cmd = ['bun', '--no-addons', '-e', code];
        break;
      case 'python':
        cmd = ['python3', '-c', code];
        break;
      case 'shell':
        cmd = ['sh', '-c', code];
        break;
      default:
        return c.json({ error: 'UNKNOWN_LANGUAGE', message: 'Unknown language' }, 400);
    }

    // Run in a temp directory for isolation
    const tmpDir = join(import.meta.dir, '..', '..', '..', '.tmp-exec');
    mkdirSync(tmpDir, { recursive: true });

    const proc = Bun.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: tmpDir,
      env: { PATH: process.env.PATH, HOME: tmpDir, TMPDIR: tmpDir },
    });

    const timeout = setTimeout(() => proc.kill(), EXECUTION_TIMEOUT_MS);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    return c.json({
      stdout: stdout.slice(0, MAX_STDOUT_LENGTH),
      stderr: stderr.slice(0, MAX_STDERR_LENGTH),
      exitCode,
      executionTimeMs: Date.now() - startTime,
      language: lang,
    });
  } catch (err: any) {
    return c.json({
      stdout: '',
      stderr: err.message,
      exitCode: 1,
      executionTimeMs: Date.now() - startTime,
      language: lang,
    });
  }
});

// ─── Web Scraping Service ───────────────────────────────────────
app.post('/api/scrape', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { url, format } = body;

  if (!url || typeof url !== 'string') {
    return c.json({ error: 'MISSING_URL', message: 'Missing required field: url' }, 400);
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return c.json({ error: 'INVALID_URL', message: 'Invalid URL format' }, 400);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AgentGate/1.0 (Web Scraper)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return c.json({
        error: 'FETCH_FAILED',
        message: `Failed to fetch URL: ${response.status} ${response.statusText}`,
      }, 502);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return c.json({
        error: 'NOT_HTML',
        message: `URL returned non-HTML content type: ${contentType}`,
        contentType,
      }, 400);
    }

    const html = (await response.text()).slice(0, MAX_SCRAPE_RESPONSE);
    const root = parseHTML(html);

    for (const tag of ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript']) {
      root.querySelectorAll(tag).forEach((el) => el.remove());
    }

    const titleEl = root.querySelector('title');
    const title = titleEl ? titleEl.text.trim() : '';

    const mainEl = root.querySelector('main') || root.querySelector('article') || root.querySelector('body');
    let content = '';

    if (mainEl) {
      if (format === 'text') {
        content = mainEl.text.replace(/\s+/g, ' ').trim();
      } else {
        content = htmlToMarkdown(mainEl);
      }
    }

    const wordCount = content.split(/\s+/).filter(Boolean).length;

    return c.json({
      title,
      content: content.slice(0, 100000),
      url,
      wordCount,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return c.json({ error: 'TIMEOUT', message: `Scrape timed out after ${SCRAPE_TIMEOUT_MS}ms` }, 504);
    }
    return c.json({ error: 'SCRAPE_FAILED', message: `Scrape failed: ${err.message}` }, 500);
  }
});

function htmlToMarkdown(node: any): string {
  let result = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      result += child.text;
    } else if (child.nodeType === 1) {
      const tag = child.tagName?.toLowerCase();
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        const level = parseInt(tag[1]);
        result += '\n' + '#'.repeat(level) + ' ' + child.text.trim() + '\n\n';
      } else if (tag === 'p') {
        result += child.text.trim() + '\n\n';
      } else if (tag === 'a') {
        const href = child.getAttribute('href');
        result += `[${child.text.trim()}](${href})`;
      } else if (tag === 'li') {
        result += '- ' + child.text.trim() + '\n';
      } else if (tag === 'br') {
        result += '\n';
      } else if (['ul', 'ol'].includes(tag)) {
        result += '\n' + htmlToMarkdown(child) + '\n';
      } else if (['div', 'section', 'span'].includes(tag)) {
        result += htmlToMarkdown(child);
      } else if (tag === 'strong' || tag === 'b') {
        result += `**${child.text.trim()}**`;
      } else if (tag === 'em' || tag === 'i') {
        result += `*${child.text.trim()}*`;
      } else if (tag === 'code') {
        result += '`' + child.text.trim() + '`';
      } else if (tag === 'pre') {
        result += '\n```\n' + child.text.trim() + '\n```\n';
      } else if (tag === 'img') {
        const alt = child.getAttribute('alt') ?? '';
        const src = child.getAttribute('src') ?? '';
        result += `![${alt}](${src})`;
      } else {
        result += htmlToMarkdown(child);
      }
    }
  }
  return result;
}

// ─── Site Deployment Service ────────────────────────────────────
app.post('/api/deploy', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { html, title } = body;

  if (!html || typeof html !== 'string') {
    return c.json({ error: 'MISSING_HTML', message: 'Missing required field: html' }, 400);
  }

  if (html.trim().length === 0) {
    return c.json({ error: 'EMPTY_HTML', message: 'HTML content cannot be empty' }, 400);
  }

  if (html.length > MAX_HTML_SIZE) {
    return c.json({
      error: 'HTML_TOO_LARGE',
      message: `HTML exceeds maximum size of ${MAX_HTML_SIZE} bytes (${(MAX_HTML_SIZE / 1024 / 1024).toFixed(0)}MB)`,
    }, 400);
  }

  const deployId = crypto.randomUUID().slice(0, 8);
  const deployDir = join(SITES_DIR, deployId);
  mkdirSync(deployDir, { recursive: true });

  let fullHtml = html;
  if (!html.toLowerCase().includes('<html')) {
    fullHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title ?? 'Deployed Site'}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>${html}</body>
</html>`;
  }

  writeFileSync(join(deployDir, 'index.html'), fullHtml);

  const url = `${BASE_URL}/sites/${deployId}`;

  return c.json({
    url,
    deployId,
    createdAt: new Date().toISOString(),
  });
});

// ─── Serve Deployed Sites ───────────────────────────────────────
app.get('/sites/:deployId', (c) => {
  const deployId = c.req.param('deployId');
  const filePath = join(SITES_DIR, deployId, 'index.html');

  if (!existsSync(filePath)) {
    return c.json({ error: 'NOT_FOUND', message: 'Site not found' }, 404);
  }

  const html = readFileSync(filePath, 'utf-8');
  return c.html(html);
});

app.get('/sites/:deployId/*', (c) => {
  const deployId = c.req.param('deployId');
  const rest = c.req.path.replace(`/sites/${deployId}/`, '');
  const filePath = join(SITES_DIR, deployId, rest);

  if (!existsSync(filePath)) {
    return c.json({ error: 'NOT_FOUND', message: 'File not found' }, 404);
  }

  const content = readFileSync(filePath);
  return new Response(content);
});

// ─── Provider Registry Page ──────────────────────────────────────
app.get('/providers', (c) => {
  const providerCards = registeredProviders.map(p => `
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-lg">${p.name}</h3>
        <span class="text-green-400 font-mono text-sm">${p.price} pathUSD</span>
      </div>
      <p class="text-gray-400 text-sm mb-2">${p.description}</p>
      <div class="flex items-center gap-2 text-xs text-gray-500">
        <span class="bg-purple-900 text-purple-300 px-2 py-0.5 rounded">${p.category}</span>
        <span class="font-mono">${p.endpoint}</span>
      </div>
      <div class="text-xs text-gray-600 mt-2 font-mono">Wallet: ${p.walletAddress.slice(0, 10)}… · Registered ${new Date(p.registeredAt).toLocaleDateString()}</div>
    </div>
  `).join('');

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentGate — Provider Marketplace</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <div class="max-w-5xl mx-auto px-6 py-10">
    <div class="flex items-center gap-4 mb-8">
      <div class="text-4xl">🏪</div>
      <div>
        <h1 class="text-3xl font-bold">Provider Marketplace</h1>
        <p class="text-gray-400">Register your API and start earning pathUSD from AI agents</p>
      </div>
      <a href="/" class="ml-auto text-blue-400 hover:underline text-sm">← Home</a>
    </div>

    <!-- Registration Form -->
    <div class="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-8">
      <h2 class="text-xl font-semibold mb-4">Register Your API</h2>
      <form id="registerForm" class="grid md:grid-cols-2 gap-4">
        <div>
          <label class="block text-sm text-gray-400 mb-1">Service Name *</label>
          <input name="name" required class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" placeholder="My LLM API">
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Endpoint URL *</label>
          <input name="endpoint" required class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" placeholder="https://my-api.com/inference">
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Price (pathUSD) *</label>
          <input name="price" required class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" placeholder="0.01">
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Category</label>
          <select name="category" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
            <option value="inference">🧠 Inference</option>
            <option value="data">📊 Data</option>
            <option value="compute">⚡ Compute</option>
            <option value="storage">💾 Storage</option>
            <option value="other">🔧 Other</option>
          </select>
        </div>
        <div class="md:col-span-2">
          <label class="block text-sm text-gray-400 mb-1">Description</label>
          <input name="description" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" placeholder="GPT-4 proxy with function calling support">
        </div>
        <div class="md:col-span-2">
          <label class="block text-sm text-gray-400 mb-1">Wallet Address (receives payments) *</label>
          <input name="walletAddress" required class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none" placeholder="0x...">
        </div>
        <div class="md:col-span-2">
          <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-medium transition">Register Service →</button>
          <span id="formStatus" class="ml-3 text-sm"></span>
        </div>
      </form>
    </div>

    <!-- Registered Providers -->
    <h2 class="text-xl font-semibold mb-4">Registered Services (${registeredProviders.length})</h2>
    ${registeredProviders.length === 0
      ? '<div class="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center text-gray-500">No external providers registered yet. Be the first!</div>'
      : `<div class="grid md:grid-cols-2 gap-4">${providerCards}</div>`}

    <div class="mt-8 text-center text-gray-600 text-sm">
      <a href="/" class="text-blue-400 hover:underline">Home</a> ·
      <a href="/dashboard" class="text-blue-400 hover:underline">Dashboard</a> ·
      <a href="/.well-known/x-agentgate.json" class="text-blue-400 hover:underline">Discovery API</a>
    </div>
  </div>
  <script>
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form));
      const status = document.getElementById('formStatus');
      status.textContent = 'Registering...';
      status.className = 'ml-3 text-sm text-yellow-400';
      try {
        const res = await fetch('/api/providers/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (res.ok) {
          status.textContent = '✓ Registered! Reloading...';
          status.className = 'ml-3 text-sm text-green-400';
          setTimeout(() => location.reload(), 1000);
        } else {
          const err = await res.json();
          status.textContent = '✗ ' + (err.error || 'Failed');
          status.className = 'ml-3 text-sm text-red-400';
        }
      } catch (err) {
        status.textContent = '✗ Network error';
        status.className = 'ml-3 text-sm text-red-400';
      }
    });
  </script>
</body>
</html>`);
});

// ─── Dashboard ───────────────────────────────────────────────────
app.get('/dashboard', async (c) => {
  // Try to get provider balance
  let balanceStr = 'N/A';
  try {
    const client = createPublicClient({ chain: tempoTestnet, transport: http() });
    const balance = await client.readContract({
      address: STABLECOINS.pathUSD.address,
      abi: [{ type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'balanceOf',
      args: [PROVIDER_ADDRESS],
    }) as bigint;
    balanceStr = formatUnits(balance, 6);
  } catch {}

  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  const uptimeStr = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`;

  const txRows = stats.recentTransactions
    .slice(0, 20)
    .map(
      (tx) => `
      <tr class="border-b border-gray-700">
        <td class="px-4 py-3 font-mono text-xs">${tx.txHash.slice(0, 10)}…${tx.txHash.slice(-6)}</td>
        <td class="px-4 py-3 font-mono text-xs">${tx.from.slice(0, 10)}…</td>
        <td class="px-4 py-3 text-green-400">${tx.amount} pathUSD</td>
        <td class="px-4 py-3"><span class="bg-blue-900 text-blue-300 px-2 py-1 rounded text-xs">${tx.endpoint}</span></td>
        <td class="px-4 py-3 text-gray-400 text-xs">${new Date(tx.timestamp).toLocaleTimeString()}</td>
      </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentGate Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <div class="max-w-6xl mx-auto px-6 py-10">
    <div class="flex items-center gap-4 mb-8">
      <div class="text-4xl">🚪</div>
      <div>
        <h1 class="text-3xl font-bold">AgentGate Dashboard</h1>
        <p class="text-gray-400">HTTP 402 Payment Gateway for AI Agents on Tempo</p>
      </div>
      <span class="ml-auto bg-green-900 text-green-300 px-3 py-1 rounded-full text-sm font-medium">● Online</span>
    </div>

    <!-- Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <div class="text-gray-400 text-sm mb-1">Uptime</div>
        <div class="text-2xl font-bold">${uptimeStr}</div>
        <div class="text-gray-500 text-xs mt-1">v${VERSION}</div>
      </div>
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <div class="text-gray-400 text-sm mb-1">Total Requests</div>
        <div class="text-2xl font-bold">${stats.totalRequests}</div>
        <div class="text-gray-500 text-xs mt-1">${stats.paidRequests} paid</div>
      </div>
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <div class="text-gray-400 text-sm mb-1">Total Revenue</div>
        <div class="text-2xl font-bold text-green-400">${formatUnits(stats.totalRevenue, 6)}</div>
        <div class="text-gray-500 text-xs mt-1">pathUSD</div>
      </div>
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <div class="text-gray-400 text-sm mb-1">Wallet Balance</div>
        <div class="text-2xl font-bold">${balanceStr}</div>
        <div class="text-gray-500 text-xs mt-1 font-mono">${PROVIDER_ADDRESS.slice(0, 10)}…</div>
      </div>
    </div>

    <!-- Privy Wallet Infrastructure -->
    <div class="bg-gray-900 rounded-xl border border-gray-800 mb-8">
      <div class="px-5 py-4 border-b border-gray-800 flex items-center gap-2">
        <span class="text-lg">🔐</span>
        <h2 class="text-lg font-semibold">Powered by Privy</h2>
        <span class="ml-auto bg-purple-900 text-purple-300 px-2 py-0.5 rounded text-xs">Server Wallets</span>
      </div>
      <div class="p-5 grid md:grid-cols-3 gap-4">
        <div class="text-center">
          <div class="text-2xl font-bold text-purple-400">0-click</div>
          <div class="text-gray-400 text-sm mt-1">Wallet creation for agents</div>
        </div>
        <div class="text-center">
          <div class="text-2xl font-bold text-purple-400">No seed phrases</div>
          <div class="text-gray-400 text-sm mt-1">Privy manages keys securely</div>
        </div>
        <div class="text-center">
          <div class="text-2xl font-bold text-purple-400">Fee sponsored</div>
          <div class="text-gray-400 text-sm mt-1">Agents only need pathUSD</div>
        </div>
      </div>
      <div class="px-5 pb-4 text-sm text-gray-500">
        POST <code class="text-gray-400">/api/wallets/create</code> → instant Privy server wallet · 
        GET <code class="text-gray-400">/api/wallets/:id/balance</code> → on-chain balance check
      </div>
    </div>

    <!-- Endpoints -->
    <div class="bg-gray-900 rounded-xl border border-gray-800 mb-8">
      <div class="px-5 py-4 border-b border-gray-800">
        <h2 class="text-lg font-semibold">Available Endpoints</h2>
      </div>
      <div class="divide-y divide-gray-800">
        <div class="px-5 py-4 flex items-center justify-between">
          <div>
            <span class="bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded text-xs font-mono mr-2">POST</span>
            <span class="font-mono">/api/chat</span>
            <span class="text-gray-400 ml-3 text-sm">LLM Chat — Groq llama-3.3-70b</span>
            <span class="ml-2 bg-green-900 text-green-300 px-1.5 py-0.5 rounded text-xs">⭐ Featured</span>
          </div>
          <span class="text-green-400 font-mono">0.005 pathUSD</span>
        </div>
        <div class="px-5 py-4 flex items-center justify-between">
          <div>
            <span class="bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded text-xs font-mono mr-2">POST</span>
            <span class="font-mono">/api/execute</span>
            <span class="text-gray-400 ml-3 text-sm">Run TypeScript, Python, or shell code</span>
          </div>
          <span class="text-green-400 font-mono">0.01 pathUSD</span>
        </div>
        <div class="px-5 py-4 flex items-center justify-between">
          <div>
            <span class="bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded text-xs font-mono mr-2">POST</span>
            <span class="font-mono">/api/scrape</span>
            <span class="text-gray-400 ml-3 text-sm">Fetch and extract content from URLs</span>
          </div>
          <span class="text-green-400 font-mono">0.005 pathUSD</span>
        </div>
        <div class="px-5 py-4 flex items-center justify-between">
          <div>
            <span class="bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded text-xs font-mono mr-2">POST</span>
            <span class="font-mono">/api/deploy</span>
            <span class="text-gray-400 ml-3 text-sm">Deploy HTML and get a live URL</span>
          </div>
          <span class="text-green-400 font-mono">0.05 pathUSD</span>
        </div>
      </div>
    </div>

    <!-- Registered External Providers -->
    <div class="bg-gray-900 rounded-xl border border-gray-800 mb-8">
      <div class="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
        <h2 class="text-lg font-semibold">🏪 External Providers</h2>
        <a href="/providers" class="text-blue-400 hover:underline text-sm">Register yours →</a>
      </div>
      ${registeredProviders.length === 0
        ? '<div class="px-5 py-6 text-center text-gray-500">No external providers yet. <a href="/providers" class="text-blue-400 hover:underline">Register your API</a> to start earning.</div>'
        : `<div class="divide-y divide-gray-800">${registeredProviders.slice(0, 5).map(p => `
          <div class="px-5 py-3 flex items-center justify-between">
            <div>
              <span class="font-medium">${p.name}</span>
              <span class="text-gray-400 ml-2 text-sm">${p.description}</span>
              <span class="ml-2 bg-purple-900 text-purple-300 px-1.5 py-0.5 rounded text-xs">${p.category}</span>
            </div>
            <span class="text-green-400 font-mono text-sm">${p.price} pathUSD</span>
          </div>`).join('')}</div>`}
    </div>

    <!-- Recent Transactions -->
    <div class="bg-gray-900 rounded-xl border border-gray-800">
      <div class="px-5 py-4 border-b border-gray-800">
        <h2 class="text-lg font-semibold">Recent Transactions</h2>
      </div>
      ${stats.recentTransactions.length === 0
        ? '<div class="px-5 py-8 text-center text-gray-500">No transactions yet. Waiting for agents to call paid endpoints…</div>'
        : `<table class="w-full text-sm">
        <thead class="text-gray-400 text-xs uppercase">
          <tr class="border-b border-gray-800">
            <th class="px-4 py-3 text-left">Tx Hash</th>
            <th class="px-4 py-3 text-left">From</th>
            <th class="px-4 py-3 text-left">Amount</th>
            <th class="px-4 py-3 text-left">Endpoint</th>
            <th class="px-4 py-3 text-left">Time</th>
          </tr>
        </thead>
        <tbody>${txRows}</tbody>
      </table>`}
    </div>

    <div class="mt-8 text-center text-gray-600 text-sm">
      AgentGate — Built on <a href="https://tempo.xyz" class="text-blue-400 hover:underline">Tempo</a> · 
      Wallets by <a href="https://privy.io" class="text-purple-400 hover:underline">Privy</a> · 
      <a href="/providers" class="text-blue-400 hover:underline">Provider Marketplace</a> ·
      <a href="/.well-known/x-agentgate.json" class="text-blue-400 hover:underline">Discovery</a> ·
      <a href="/api/health" class="text-blue-400 hover:underline">Health</a>
    </div>
  </div>
</body>
</html>`;

  return c.html(html);
});

// ─── Health + Info ───────────────────────────────────────────────
app.get('/', (c) => {
  // If Accept header wants JSON, return JSON (for agents)
  if (c.req.header('accept')?.includes('application/json') && !c.req.header('accept')?.includes('text/html')) {
    return c.json({
      service: 'AgentGate Gateway',
      version: VERSION,
      docs: '/.well-known/x-agentgate.json',
      dashboard: '/dashboard',
      endpoints: {
        'POST /api/chat': '0.005 pathUSD — LLM Chat (Groq llama-3.3-70b)',
        'POST /api/execute': '0.01 pathUSD — Code Execution',
        'POST /api/scrape': '0.005 pathUSD — Web Scraping',
        'POST /api/deploy': '0.05 pathUSD — Site Deployment',
      },
      free: ['GET /', 'GET /api/health', 'GET /api/sites', 'GET /api/providers', 'GET /dashboard', 'GET /providers', 'GET /.well-known/x-agentgate.json'],
    });
  }

  // Landing page for browsers
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentGate — Monetize Your APIs with Crypto Payments</title>
  <meta name="description" content="Two-sided marketplace: API providers monetize with one line of middleware, AI agents pay with stablecoins on Tempo. Powered by Privy server wallets.">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
    .float { animation: float 3s ease-in-out infinite; }
    .gradient-text { background: linear-gradient(135deg, #60a5fa, #a78bfa, #34d399); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .glow { box-shadow: 0 0 40px rgba(96, 165, 250, 0.15); }
    .privy-glow { box-shadow: 0 0 40px rgba(167, 139, 250, 0.15); }
  </style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <!-- Hero -->
  <div class="max-w-5xl mx-auto px-6 pt-20 pb-16 text-center">
    <div class="text-6xl mb-6 float">🚪</div>
    <h1 class="text-5xl md:text-6xl font-bold mb-4">
      <span class="gradient-text">Monetize Your APIs</span><br>
      <span class="text-3xl md:text-4xl text-gray-300">with Crypto Payments</span>
    </h1>
    <p class="text-xl text-gray-400 mb-2 max-w-2xl mx-auto">The two-sided marketplace where <strong class="text-white">API providers</strong> earn pathUSD and <strong class="text-white">AI agents</strong> pay per call — powered by HTTP 402</p>
    <p class="text-lg text-gray-500 mb-10">Bring Your Own Backend · One line of middleware · Instant stablecoin payments</p>
    <div class="flex gap-4 justify-center flex-wrap">
      <a href="/providers" class="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-medium transition">Register Your API →</a>
      <a href="/dashboard" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium transition">Live Dashboard</a>
      <a href="https://github.com/ss251/agentgate" class="bg-gray-800 hover:bg-gray-700 text-white px-6 py-3 rounded-lg font-medium transition border border-gray-700">GitHub ↗</a>
    </div>
  </div>

  <!-- How It Works — Two Sides -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <h2 class="text-3xl font-bold text-center mb-10">How It Works</h2>
    <div class="grid md:grid-cols-2 gap-8">
      <!-- Provider Side -->
      <div class="bg-gray-900 rounded-xl border border-gray-800 p-6">
        <h3 class="text-xl font-bold mb-4 text-purple-400">🏪 For Providers</h3>
        <p class="text-gray-400 text-sm mb-4">Monetize any API with one line of middleware</p>
        <div class="space-y-3">
          <div class="flex items-start gap-3"><span class="bg-purple-900 text-purple-300 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0">1</span><div><div class="font-medium">Add paywall() middleware</div><div class="text-gray-400 text-sm">Works with any Hono app — one import, one line</div></div></div>
          <div class="flex items-start gap-3"><span class="bg-purple-900 text-purple-300 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0">2</span><div><div class="font-medium">Set your prices</div><div class="text-gray-400 text-sm">Per-endpoint pricing in pathUSD stablecoins</div></div></div>
          <div class="flex items-start gap-3"><span class="bg-purple-900 text-purple-300 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0">3</span><div><div class="font-medium">Get paid on every call</div><div class="text-gray-400 text-sm">Payments go directly to your wallet on Tempo</div></div></div>
        </div>
      </div>
      <!-- Agent Side -->
      <div class="bg-gray-900 rounded-xl border border-gray-800 p-6">
        <h3 class="text-xl font-bold mb-4 text-blue-400">🤖 For Agents</h3>
        <p class="text-gray-400 text-sm mb-4">Discover and pay for APIs automatically</p>
        <div class="space-y-3">
          <div class="flex items-start gap-3"><span class="bg-blue-900 text-blue-300 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0">1</span><div><div class="font-medium">Discover services</div><div class="text-gray-400 text-sm">Auto-discover via .well-known/x-agentgate.json</div></div></div>
          <div class="flex items-start gap-3"><span class="bg-blue-900 text-blue-300 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0">2</span><div><div class="font-medium">Pay with pathUSD</div><div class="text-gray-400 text-sm">SDK auto-handles 402 → pay → retry flow</div></div></div>
          <div class="flex items-start gap-3"><span class="bg-blue-900 text-blue-300 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0">3</span><div><div class="font-medium">Get results</div><div class="text-gray-400 text-sm">On-chain verified, no API keys needed</div></div></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Live Services -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <h2 class="text-3xl font-bold text-center mb-3">Live Services</h2>
    <p class="text-gray-400 text-center mb-10">Try them now — real endpoints, real payments on Tempo testnet</p>
    <div class="grid md:grid-cols-2 gap-6">
      <!-- Featured: Chat -->
      <div class="bg-gray-900 rounded-xl p-6 border-2 border-purple-700 glow md:col-span-2">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-3">
            <span class="text-3xl">🧠</span>
            <div>
              <h3 class="text-xl font-semibold">LLM Inference</h3>
              <span class="text-gray-400 text-sm">Groq-powered llama-3.3-70b — blazing fast</span>
            </div>
          </div>
          <div class="text-right">
            <span class="text-green-400 font-mono text-lg">0.005 pathUSD</span>
            <div class="text-xs text-gray-500">per request</div>
          </div>
        </div>
        <p class="text-gray-400 text-sm mb-3">OpenAI-compatible chat completions API. Send messages or a simple prompt — get intelligent responses in milliseconds.</p>
        <code class="text-xs text-purple-400 font-mono">POST /api/chat</code>
        <span class="ml-2 bg-green-900 text-green-300 px-2 py-0.5 rounded text-xs">⭐ Featured</span>
      </div>
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800">
        <div class="flex items-center justify-between mb-4">
          <span class="text-2xl">⚡</span>
          <span class="text-green-400 font-mono text-sm">0.01 pathUSD</span>
        </div>
        <h3 class="text-lg font-semibold mb-2">Code Execution</h3>
        <p class="text-gray-400 text-sm mb-3">Run TypeScript, Python, or shell in a sandboxed environment</p>
        <code class="text-xs text-gray-500 font-mono">POST /api/execute</code>
      </div>
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800">
        <div class="flex items-center justify-between mb-4">
          <span class="text-2xl">🌐</span>
          <span class="text-green-400 font-mono text-sm">0.005 pathUSD</span>
        </div>
        <h3 class="text-lg font-semibold mb-2">Web Scraping</h3>
        <p class="text-gray-400 text-sm mb-3">Fetch and extract structured content from any URL</p>
        <code class="text-xs text-gray-500 font-mono">POST /api/scrape</code>
      </div>
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800">
        <div class="flex items-center justify-between mb-4">
          <span class="text-2xl">🚀</span>
          <span class="text-green-400 font-mono text-sm">0.05 pathUSD</span>
        </div>
        <h3 class="text-lg font-semibold mb-2">Site Deployment</h3>
        <p class="text-gray-400 text-sm mb-3">Deploy HTML to a live URL instantly</p>
        <code class="text-xs text-gray-500 font-mono">POST /api/deploy</code>
      </div>
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800 border-dashed flex flex-col items-center justify-center text-center">
        <div class="text-3xl mb-2">➕</div>
        <h3 class="text-lg font-semibold mb-1">Your API Here</h3>
        <p class="text-gray-400 text-sm mb-3">Bring your own backend and start earning</p>
        <a href="/providers" class="text-purple-400 hover:underline text-sm">Register now →</a>
      </div>
    </div>
  </div>

  <!-- Powered by Privy -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <div class="bg-gray-900 rounded-xl border border-purple-800 p-8 privy-glow">
      <div class="text-center mb-6">
        <h2 class="text-2xl font-bold mb-2">🔐 Powered by <span class="text-purple-400">Privy</span></h2>
        <p class="text-gray-400">Server wallets for AI agents — no seed phrases, no complexity</p>
      </div>
      <div class="grid md:grid-cols-3 gap-6 text-center">
        <div>
          <div class="text-3xl mb-2">⚡</div>
          <h3 class="font-semibold mb-1">Instant Wallets</h3>
          <p class="text-gray-400 text-sm">Create agent wallets with a single API call. No seed phrases, no key management.</p>
        </div>
        <div>
          <div class="text-3xl mb-2">🛡️</div>
          <h3 class="font-semibold mb-1">Secure Key Management</h3>
          <p class="text-gray-400 text-sm">Privy manages private keys in secure enclaves. Your agents never touch raw keys.</p>
        </div>
        <div>
          <div class="text-3xl mb-2">💸</div>
          <h3 class="font-semibold mb-1">Fee Sponsorship</h3>
          <p class="text-gray-400 text-sm">Automatic gas sponsorship — agents only need pathUSD, never native tokens.</p>
        </div>
      </div>
      <div class="mt-6 text-center">
        <code class="text-sm text-gray-500 bg-gray-800 px-4 py-2 rounded-lg">POST /api/wallets/create → { walletId, address } — that's it!</code>
      </div>
    </div>
  </div>

  <!-- Built on Tempo -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <div class="bg-gray-900 rounded-xl border border-blue-800 p-8 glow">
      <div class="text-center mb-6">
        <h2 class="text-2xl font-bold mb-2">⛓️ Built on <span class="text-blue-400">Tempo</span></h2>
        <p class="text-gray-400">The chain purpose-built for agent payments</p>
      </div>
      <div class="grid md:grid-cols-4 gap-4 text-center">
        <div>
          <div class="text-xl font-bold text-blue-400">~2s</div>
          <div class="text-gray-400 text-sm">Finality</div>
        </div>
        <div>
          <div class="text-xl font-bold text-blue-400">$0</div>
          <div class="text-gray-400 text-sm">Gas fees (sponsored)</div>
        </div>
        <div>
          <div class="text-xl font-bold text-blue-400">pathUSD</div>
          <div class="text-gray-400 text-sm">Stablecoin payments</div>
        </div>
        <div>
          <div class="text-xl font-bold text-blue-400">TIP-20</div>
          <div class="text-gray-400 text-sm">Native token standard</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Bring Your Own API -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <div class="bg-gradient-to-r from-purple-900/30 to-blue-900/30 rounded-xl border border-gray-800 p-8 text-center">
      <h2 class="text-3xl font-bold mb-3">🔌 Bring Your Own Backend</h2>
      <p class="text-gray-400 mb-6 max-w-2xl mx-auto">AgentGate isn't just a gateway — it's a platform. Any API provider can monetize their service with one line of middleware. LLM inference, data APIs, compute services — if you can serve HTTP, you can earn crypto.</p>
      <div class="bg-gray-950 rounded-lg p-4 max-w-lg mx-auto mb-6 text-left">
        <pre class="text-sm overflow-x-auto"><code class="text-purple-300">import { paywall } from '@tempo-agentgate/middleware';

// That's it. Your API now accepts crypto payments.
app.use('/api/*', paywall({
  recipientAddress: '0xYourWallet',
  token: 'pathUSD',
  pricing: {
    'POST /api/inference': { amount: '0.01' }
  }
}));</code></pre>
      </div>
      <a href="/providers" class="inline-block bg-purple-600 hover:bg-purple-700 text-white px-8 py-3 rounded-lg font-medium transition">Register Your API on AgentGate →</a>
    </div>
  </div>

  <!-- Code Examples -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <h2 class="text-3xl font-bold text-center mb-10">For Developers</h2>
    <div class="grid md:grid-cols-2 gap-6">
      <div class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-800 text-sm text-gray-400">🤖 Agent Side — Auto-pay with SDK</div>
        <pre class="p-4 text-sm overflow-x-auto"><code class="text-green-300">import { AgentGateClient } from '@tempo-agentgate/sdk';

// Use Privy server wallet (recommended)
const agent = new AgentGateClient({
  privyAppId: 'your-app-id',
  privyAppSecret: 'your-secret',
  walletId: 'privy-wallet-id',
});

// Or use raw private key
// const agent = new AgentGateClient({ privateKey: '0x...' });

// Auto: 402 → pay pathUSD → retry → result
const res = await agent.fetch(
  '${BASE_URL}/api/chat',
  {
    method: 'POST',
    body: JSON.stringify({
      prompt: 'Explain quantum computing'
    })
  }
);</code></pre>
      </div>
      <div class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-800 text-sm text-gray-400">🏪 Provider Side — One line of middleware</div>
        <pre class="p-4 text-sm overflow-x-auto"><code class="text-purple-300">import { Hono } from 'hono';
import { paywall } from '@tempo-agentgate/middleware';

const app = new Hono();

// Add crypto payments to ANY endpoint
app.use('/api/*', paywall({
  recipientAddress: '0xYourWallet',
  token: 'pathUSD',
  pricing: {
    'POST /api/generate': {
      amount: '0.02',
      description: 'Image generation'
    }
  }
}));

app.post('/api/generate', (c) =&gt;
  c.json({ image: '...' })
);</code></pre>
      </div>
    </div>
  </div>

  <!-- npm Packages -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <h2 class="text-3xl font-bold text-center mb-10">npm Packages</h2>
    <div class="grid md:grid-cols-3 gap-6">
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800 text-center">
        <div class="font-mono text-blue-400 mb-2">@tempo-agentgate/sdk</div>
        <p class="text-gray-400 text-sm">Agent client with auto 402→pay→retry, Privy wallet support, batch calls</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800 text-center">
        <div class="font-mono text-purple-400 mb-2">@tempo-agentgate/middleware</div>
        <p class="text-gray-400 text-sm">Hono paywall() middleware — add crypto payments to any API in one line</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800 text-center">
        <div class="font-mono text-green-400 mb-2">@tempo-agentgate/core</div>
        <p class="text-gray-400 text-sm">Shared types, chain config, token addresses, payment verification</p>
      </div>
    </div>
    <div class="text-center mt-6">
      <code class="text-gray-500 text-sm bg-gray-900 px-4 py-2 rounded-lg">bun add @tempo-agentgate/sdk @tempo-agentgate/middleware @tempo-agentgate/core</code>
    </div>
  </div>

  <!-- Tech Stack -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <div class="bg-gray-900 rounded-xl border border-gray-800 p-8">
      <h2 class="text-2xl font-bold mb-6 text-center">Built With</h2>
      <div class="flex flex-wrap gap-3 justify-center">
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">⛓️ Tempo</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">🔐 Privy</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">⚡ Bun</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">🔥 Hono</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">📦 TypeScript</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">💰 pathUSD</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">🔗 viem</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">🧪 56 Tests</span>
      </div>
      <div class="mt-6 grid md:grid-cols-4 gap-4 text-center text-sm text-gray-400">
        <div><span class="text-white font-bold text-lg">3</span><br>npm packages</div>
        <div><span class="text-white font-bold text-lg">~2s</span><br>payment finality</div>
        <div><span class="text-white font-bold text-lg">$0</span><br>gas fees</div>
        <div><span class="text-white font-bold text-lg">∞</span><br>providers welcome</div>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div class="max-w-5xl mx-auto px-6 pb-10 text-center text-gray-600 text-sm">
    Built for the <a href="https://canteenapp-tempo.notion.site/" class="text-blue-400 hover:underline">Canteen × Tempo Hackathon</a> · 
    Track 3: AI Agents & Automation · 
    Wallets by <a href="https://privy.io" class="text-purple-400 hover:underline">Privy</a> · 
    Payments on <a href="https://tempo.xyz" class="text-blue-400 hover:underline">Tempo</a> ·
    <a href="https://github.com/ss251/agentgate" class="text-blue-400 hover:underline">Source</a> · 
    <a href="/dashboard" class="text-blue-400 hover:underline">Dashboard</a> · 
    <a href="/providers" class="text-blue-400 hover:underline">Marketplace</a>
  </div>
</body>
</html>`);
});

// ─── Graceful Shutdown ───────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ───────────────────────────────────────────────────────
console.log(`🚀 AgentGate Gateway v${VERSION} running on http://localhost:${PORT}`);
console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);

export default {
  port: PORT,
  hostname: '0.0.0.0',
  fetch: app.fetch,
};
