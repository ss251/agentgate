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

// ─── Persistent Stats ────────────────────────────────────────────
const STATS_FILE = new URL('../.stats.json', import.meta.url).pathname;

interface StatsData {
  totalRequests: number;
  paidRequests: number;
  totalRevenue: string; // bigint serialized as string
  recentTransactions: TransactionLog[];
}

function loadStats(): { totalRequests: number; paidRequests: number; totalRevenue: bigint; recentTransactions: TransactionLog[] } {
  try {
    const raw = require('fs').readFileSync(STATS_FILE, 'utf-8');
    const data: StatsData = JSON.parse(raw);
    return {
      totalRequests: data.totalRequests || 0,
      paidRequests: data.paidRequests || 0,
      totalRevenue: BigInt(data.totalRevenue || '0'),
      recentTransactions: data.recentTransactions || [],
    };
  } catch {
    return { totalRequests: 0, paidRequests: 0, totalRevenue: BigInt(0), recentTransactions: [] };
  }
}

function saveStats() {
  const data: StatsData = {
    totalRequests: stats.totalRequests,
    paidRequests: stats.paidRequests,
    totalRevenue: stats.totalRevenue.toString(),
    recentTransactions: stats.recentTransactions,
  };
  try {
    require('fs').writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to persist stats:', e);
  }
}

const stats = loadStats();

// ─── Passkey Credential Store (In-Memory) ────────────────────────
interface PasskeyCredential {
  id: string;
  credentialId: string;
  publicKey: string;
  displayName: string;
  registeredAt: string;
}

const passkeyCredentials: PasskeyCredential[] = [];

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
  saveStats();
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
      saveStats();
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

// ─── Passkey API Endpoints ───────────────────────────────────────
app.post('/auth/passkey/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { credentialId, publicKey, displayName } = body;
  if (!credentialId || !publicKey) {
    return c.json({ error: 'Missing credentialId or publicKey' }, 400);
  }
  const cred: PasskeyCredential = {
    id: crypto.randomUUID().slice(0, 8),
    credentialId,
    publicKey,
    displayName: displayName ?? 'Anonymous',
    registeredAt: new Date().toISOString(),
  };
  passkeyCredentials.push(cred);
  return c.json({ credential: cred, message: 'Passkey registered' }, 201);
});

app.get('/auth/passkey/credentials', (c) => {
  return c.json({ credentials: passkeyCredentials, count: passkeyCredentials.length });
});

// ─── Passkey Auth Page ───────────────────────────────────────────
app.get('/auth/passkey', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentGate — Passkey Authentication</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <div class="max-w-2xl mx-auto px-6 py-10">
    <div class="flex items-center gap-4 mb-8">
      <div class="text-4xl">🔐</div>
      <div>
        <h1 class="text-3xl font-bold">Passkey Authentication</h1>
        <p class="text-gray-400">Tempo-native WebAuthn passkey accounts</p>
      </div>
      <a href="/dashboard" class="ml-auto text-blue-400 hover:underline text-sm">← Dashboard</a>
    </div>

    <div class="bg-gray-900 rounded-xl border border-purple-800 p-6 mb-6">
      <div class="flex items-center gap-2 mb-3">
        <span class="text-purple-400 font-semibold">⛓️ Tempo-Native Passkeys</span>
      </div>
      <p class="text-gray-400 text-sm mb-3">
        Tempo supports <strong class="text-white">P256/WebAuthn signatures natively at the protocol level</strong>.
        This means your passkey (Face ID, Touch ID, security key) can directly control a Tempo account —
        no seed phrases, no browser extensions.
      </p>
      <a href="https://docs.tempo.xyz/guide/use-accounts/embed-passkeys" target="_blank"
         class="text-purple-400 hover:underline text-sm">📖 Tempo Passkey Docs →</a>
    </div>

    <!-- Sign Up -->
    <div class="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Create Passkey Account</h2>
      <div class="mb-4">
        <label class="block text-sm text-gray-400 mb-1">Display Name</label>
        <input id="displayName" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-purple-500 focus:outline-none" placeholder="Your name" value="">
      </div>
      <button id="registerBtn" class="bg-purple-600 hover:bg-purple-700 text-white px-6 py-2.5 rounded-lg font-medium transition w-full">
        🔐 Sign Up with Passkey
      </button>
      <div id="registerStatus" class="mt-3 text-sm"></div>
    </div>

    <!-- Sign In -->
    <div class="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Sign In with Passkey</h2>
      <button id="loginBtn" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-medium transition w-full">
        🔑 Sign In with Passkey
      </button>
      <div id="loginStatus" class="mt-3 text-sm"></div>
    </div>

    <!-- Credential Info -->
    <div id="credentialInfo" class="hidden bg-gray-900 rounded-xl border border-green-800 p-6 mb-6">
      <h2 class="text-xl font-semibold mb-3 text-green-400">✅ Authenticated</h2>
      <div class="space-y-2 text-sm">
        <div><span class="text-gray-400">Credential ID:</span> <code id="credId" class="text-green-300 text-xs break-all"></code></div>
        <div><span class="text-gray-400">Public Key (P256):</span> <code id="credPubKey" class="text-green-300 text-xs break-all"></code></div>
        <div><span class="text-gray-400">Display Name:</span> <span id="credName" class="text-white"></span></div>
      </div>
      <p class="text-gray-500 text-xs mt-3">This P256 public key can be used as a Tempo account identifier — no seed phrase needed.</p>
    </div>

    <div class="text-center text-gray-600 text-sm">
      <a href="/" class="text-blue-400 hover:underline">Home</a> ·
      <a href="/dashboard" class="text-blue-400 hover:underline">Dashboard</a> ·
      <a href="/providers" class="text-blue-400 hover:underline">Providers</a>
    </div>
  </div>
  <script>
    function bufToBase64url(buf) {
      return btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }

    document.getElementById('registerBtn').addEventListener('click', async () => {
      const status = document.getElementById('registerStatus');
      const name = document.getElementById('displayName').value || 'AgentGate User';
      status.textContent = 'Creating passkey...';
      status.className = 'mt-3 text-sm text-yellow-400';

      try {
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const credential = await navigator.credentials.create({
          publicKey: {
            challenge,
            rp: { name: 'AgentGate', id: location.hostname },
            user: {
              id: crypto.getRandomValues(new Uint8Array(16)),
              name: name,
              displayName: name,
            },
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },   // ES256 (P-256) — Tempo native!
              { type: 'public-key', alg: -257 },  // RS256 fallback
            ],
            authenticatorSelection: {
              authenticatorAttachment: 'platform',
              userVerification: 'preferred',
              residentKey: 'preferred',
            },
            timeout: 60000,
          }
        });

        const credId = bufToBase64url(credential.rawId);
        const attestation = bufToBase64url(credential.response.attestationObject);

        // Store on server
        const res = await fetch('/auth/passkey/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            credentialId: credId,
            publicKey: attestation,
            displayName: name,
          }),
        });

        if (res.ok) {
          status.textContent = '✅ Passkey created successfully!';
          status.className = 'mt-3 text-sm text-green-400';
          showCredential(credId, attestation.slice(0, 64) + '...', name);
        } else {
          status.textContent = '✗ Registration failed';
          status.className = 'mt-3 text-sm text-red-400';
        }
      } catch (err) {
        status.textContent = '✗ ' + (err.message || 'Passkey creation failed');
        status.className = 'mt-3 text-sm text-red-400';
      }
    });

    document.getElementById('loginBtn').addEventListener('click', async () => {
      const status = document.getElementById('loginStatus');
      status.textContent = 'Requesting passkey...';
      status.className = 'mt-3 text-sm text-yellow-400';

      try {
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge,
            rpId: location.hostname,
            userVerification: 'preferred',
            timeout: 60000,
          }
        });

        const credId = bufToBase64url(assertion.rawId);
        const sig = bufToBase64url(assertion.response.signature);

        status.textContent = '✅ Signed in successfully!';
        status.className = 'mt-3 text-sm text-green-400';
        showCredential(credId, sig.slice(0, 64) + '...', 'Authenticated User');
      } catch (err) {
        status.textContent = '✗ ' + (err.message || 'Sign-in failed');
        status.className = 'mt-3 text-sm text-red-400';
      }
    });

    function showCredential(id, key, name) {
      document.getElementById('credentialInfo').classList.remove('hidden');
      document.getElementById('credId').textContent = id;
      document.getElementById('credPubKey').textContent = key;
      document.getElementById('credName').textContent = name;
    }
  </script>
</body>
</html>`);
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
      <a href="/auth/passkey" class="text-purple-400 hover:underline">🔐 Sign in with Passkey</a> ·
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
      <a href="/auth/passkey" class="text-purple-400 hover:underline">🔐 Sign in with Passkey</a> ·
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
  <title>AgentGate — HTTP 402 Payment Gateway for AI Agents</title>
  <meta name="description" content="AI agents pay for APIs with stablecoins. Providers monetize with one line of middleware. Built on Tempo.">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config={theme:{extend:{fontFamily:{mono:['JetBrains Mono','ui-monospace','SFMono-Regular','monospace']},colors:{ag:{50:'#f0f4ff',100:'#e0e7ff',400:'#818cf8',500:'#6366f1',600:'#4f46e5',900:'#1e1b4b'}}}}}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
    code, pre, .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .code-block { background: #0d1117; border: 1px solid #21262d; }
    .line-num { color: #484f58; user-select: none; }
    .tok-kw { color: #ff7b72; }
    .tok-str { color: #a5d6ff; }
    .tok-fn { color: #d2a8ff; }
    .tok-cm { color: #8b949e; }
    .tok-const { color: #79c0ff; }
    .tok-op { color: #c9d1d9; }
  </style>
</head>
<body class="bg-[#0a0a0a] text-[#ededed] min-h-screen antialiased">

  <!-- Nav -->
  <nav class="border-b border-white/5">
    <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
      <div class="flex items-center gap-6">
        <a href="/" class="text-[15px] font-semibold tracking-tight">AgentGate</a>
        <div class="hidden sm:flex items-center gap-5 text-[13px] text-[#888]">
          <a href="/dashboard" class="hover:text-white transition">Dashboard</a>
          <a href="/providers" class="hover:text-white transition">Marketplace</a>
          <a href="/.well-known/x-agentgate.json" class="hover:text-white transition">API</a>
          <a href="https://github.com/ss251/agentgate" class="hover:text-white transition">GitHub</a>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <a href="/auth/passkey" class="text-[13px] text-[#888] hover:text-white transition">Sign in</a>
        <a href="/providers" class="text-[13px] bg-white text-black px-3 py-1.5 rounded-md font-medium hover:bg-white/90 transition">List your API</a>
      </div>
    </div>
  </nav>

  <!-- Hero -->
  <section class="max-w-6xl mx-auto px-6 pt-24 pb-20">
    <div class="max-w-3xl">
      <p class="text-[13px] font-medium text-ag-400 mb-4 tracking-wide uppercase">HTTP 402 Payment Protocol</p>
      <h1 class="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5">
        AI agents pay for APIs<br>with stablecoins.
      </h1>
      <p class="text-lg text-[#888] leading-relaxed max-w-xl mb-8">
        AgentGate turns any API into a paid service. Agents get a 402, pay on-chain, and retry — all in one round trip. No API keys. No subscriptions. Just code and crypto.
      </p>
      <div class="flex items-center gap-3 mb-12">
        <a href="#how-it-works" class="text-sm bg-white text-black px-5 py-2.5 rounded-md font-medium hover:bg-white/90 transition">How it works</a>
        <a href="#code" class="text-sm text-[#888] border border-white/10 px-5 py-2.5 rounded-md font-medium hover:text-white hover:border-white/20 transition">View code</a>
      </div>
      <!-- The 402 flow, shown as a terminal-style sequence -->
      <div class="code-block rounded-lg p-5 text-[13px] leading-6">
        <div><span class="tok-cm"># Agent calls a paid API</span></div>
        <div><span class="tok-const">$</span> curl -X POST ${BASE_URL}/api/chat</div>
        <div class="mt-2"><span class="tok-cm"># Gateway responds: pay first</span></div>
        <div><span class="tok-kw">HTTP 402</span> Payment Required</div>
        <div class="text-[#8b949e]">X-Payment-Amount: 0.005</div>
        <div class="text-[#8b949e]">X-Payment-Token: pathUSD</div>
        <div class="text-[#8b949e]">X-Payment-Recipient: ${PROVIDER_ADDRESS.slice(0, 18)}…</div>
        <div class="mt-2"><span class="tok-cm"># Agent pays on Tempo, retries with tx hash</span></div>
        <div><span class="tok-const">$</span> curl -X POST ${BASE_URL}/api/chat \\</div>
        <div>  -H <span class="tok-str">"X-Payment-Hash: 0xabc…def"</span></div>
        <div class="mt-2"><span class="tok-kw">HTTP 200</span> OK</div>
        <div class="text-[#8b949e]">{ "response": "Quantum computing uses qubits…" }</div>
      </div>
    </div>
  </section>

  <!-- How it works -->
  <section id="how-it-works" class="border-t border-white/5">
    <div class="max-w-6xl mx-auto px-6 py-20">
      <h2 class="text-2xl font-semibold tracking-tight mb-12">How it works</h2>
      <div class="grid md:grid-cols-3 gap-px bg-white/5 rounded-lg overflow-hidden">
        <div class="bg-[#0a0a0a] p-8">
          <div class="text-[13px] font-mono text-ag-400 mb-3">01</div>
          <h3 class="text-[15px] font-semibold mb-2">Agent discovers services</h3>
          <p class="text-[14px] text-[#888] leading-relaxed">Standard <code class="text-[13px] text-[#ccc]">/.well-known/x-agentgate.json</code> endpoint lists available APIs, prices, and payment details. No signup required.</p>
        </div>
        <div class="bg-[#0a0a0a] p-8">
          <div class="text-[13px] font-mono text-ag-400 mb-3">02</div>
          <h3 class="text-[15px] font-semibold mb-2">402 triggers payment</h3>
          <p class="text-[14px] text-[#888] leading-relaxed">Agent hits a paid endpoint, gets HTTP 402 with payment instructions. The SDK sends pathUSD on Tempo — confirmation in ~2 seconds.</p>
        </div>
        <div class="bg-[#0a0a0a] p-8">
          <div class="text-[13px] font-mono text-ag-400 mb-3">03</div>
          <h3 class="text-[15px] font-semibold mb-2">Verify and serve</h3>
          <p class="text-[14px] text-[#888] leading-relaxed">Gateway verifies the tx on-chain, credits the provider's wallet, and returns the API response. One round trip.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Services -->
  <section class="border-t border-white/5">
    <div class="max-w-6xl mx-auto px-6 py-20">
      <div class="flex items-end justify-between mb-10">
        <div>
          <h2 class="text-2xl font-semibold tracking-tight mb-1">Live endpoints</h2>
          <p class="text-[14px] text-[#888]">Running on Tempo testnet. Real payments, real services.</p>
        </div>
        <a href="/providers" class="text-[13px] text-ag-400 hover:text-ag-100 transition">Add yours →</a>
      </div>
      <div class="border border-white/5 rounded-lg overflow-hidden">
        <table class="w-full text-[14px]">
          <thead>
            <tr class="border-b border-white/5 text-[12px] text-[#666] uppercase tracking-wider">
              <th class="text-left px-5 py-3 font-medium">Endpoint</th>
              <th class="text-left px-5 py-3 font-medium hidden sm:table-cell">Description</th>
              <th class="text-right px-5 py-3 font-medium">Price</th>
            </tr>
          </thead>
          <tbody>
            <tr class="border-b border-white/5 hover:bg-white/[0.02] transition">
              <td class="px-5 py-4"><code class="text-[13px]"><span class="text-emerald-400">POST</span> /api/chat</code></td>
              <td class="px-5 py-4 text-[#888] hidden sm:table-cell">LLM inference — Groq llama-3.3-70b</td>
              <td class="px-5 py-4 text-right font-mono text-[13px]">0.005 <span class="text-[#666]">pathUSD</span></td>
            </tr>
            <tr class="border-b border-white/5 hover:bg-white/[0.02] transition">
              <td class="px-5 py-4"><code class="text-[13px]"><span class="text-emerald-400">POST</span> /api/execute</code></td>
              <td class="px-5 py-4 text-[#888] hidden sm:table-cell">Sandboxed code execution — TS, Python, shell</td>
              <td class="px-5 py-4 text-right font-mono text-[13px]">0.010 <span class="text-[#666]">pathUSD</span></td>
            </tr>
            <tr class="border-b border-white/5 hover:bg-white/[0.02] transition">
              <td class="px-5 py-4"><code class="text-[13px]"><span class="text-emerald-400">POST</span> /api/scrape</code></td>
              <td class="px-5 py-4 text-[#888] hidden sm:table-cell">Web scraping — fetch and extract content</td>
              <td class="px-5 py-4 text-right font-mono text-[13px]">0.005 <span class="text-[#666]">pathUSD</span></td>
            </tr>
            <tr class="hover:bg-white/[0.02] transition">
              <td class="px-5 py-4"><code class="text-[13px]"><span class="text-emerald-400">POST</span> /api/deploy</code></td>
              <td class="px-5 py-4 text-[#888] hidden sm:table-cell">Deploy HTML to a live URL</td>
              <td class="px-5 py-4 text-right font-mono text-[13px]">0.050 <span class="text-[#666]">pathUSD</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- Code -->
  <section id="code" class="border-t border-white/5">
    <div class="max-w-6xl mx-auto px-6 py-20">
      <h2 class="text-2xl font-semibold tracking-tight mb-10">Integration</h2>
      <div class="grid lg:grid-cols-2 gap-6">
        <div>
          <div class="text-[12px] text-[#666] uppercase tracking-wider mb-3 font-medium">Agent — pay for APIs</div>
          <div class="code-block rounded-lg overflow-hidden">
            <div class="px-5 py-3 border-b border-white/5 text-[12px] text-[#666]">agent.ts</div>
            <pre class="p-5 text-[13px] leading-6 overflow-x-auto"><code><span class="tok-kw">import</span> { AgentGateClient } <span class="tok-kw">from</span> <span class="tok-str">'@tempo-agentgate/sdk'</span>

<span class="tok-kw">const</span> agent = <span class="tok-kw">new</span> <span class="tok-fn">AgentGateClient</span>({
  <span class="tok-cm">// Privy server wallet — no seed phrases</span>
  privyAppId: <span class="tok-str">'your-app-id'</span>,
  privyAppSecret: <span class="tok-str">'your-secret'</span>,
  walletId: <span class="tok-str">'privy-wallet-id'</span>,
})

<span class="tok-cm">// SDK handles 402 → pay → retry automatically</span>
<span class="tok-kw">const</span> res = <span class="tok-kw">await</span> agent.<span class="tok-fn">fetch</span>(
  <span class="tok-str">'${BASE_URL}/api/chat'</span>,
  {
    method: <span class="tok-str">'POST'</span>,
    body: JSON.<span class="tok-fn">stringify</span>({
      prompt: <span class="tok-str">'Explain quantum computing'</span>
    })
  }
)</code></pre>
          </div>
        </div>
        <div>
          <div class="text-[12px] text-[#666] uppercase tracking-wider mb-3 font-medium">Provider — monetize any API</div>
          <div class="code-block rounded-lg overflow-hidden">
            <div class="px-5 py-3 border-b border-white/5 text-[12px] text-[#666]">server.ts</div>
            <pre class="p-5 text-[13px] leading-6 overflow-x-auto"><code><span class="tok-kw">import</span> { Hono } <span class="tok-kw">from</span> <span class="tok-str">'hono'</span>
<span class="tok-kw">import</span> { paywall } <span class="tok-kw">from</span> <span class="tok-str">'@tempo-agentgate/middleware'</span>

<span class="tok-kw">const</span> app = <span class="tok-kw">new</span> <span class="tok-fn">Hono</span>()

<span class="tok-cm">// One line. Your API now accepts crypto.</span>
app.<span class="tok-fn">use</span>(<span class="tok-str">'/api/*'</span>, <span class="tok-fn">paywall</span>({
  recipientAddress: <span class="tok-str">'0xYourWallet'</span>,
  token: <span class="tok-str">'pathUSD'</span>,
  pricing: {
    <span class="tok-str">'POST /api/generate'</span>: {
      amount: <span class="tok-str">'0.02'</span>
    }
  }
}))

app.<span class="tok-fn">post</span>(<span class="tok-str">'/api/generate'</span>, (c) =&gt;
  c.<span class="tok-fn">json</span>({ result: <span class="tok-str">'...'</span> })
)</code></pre>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Packages -->
  <section class="border-t border-white/5">
    <div class="max-w-6xl mx-auto px-6 py-20">
      <h2 class="text-2xl font-semibold tracking-tight mb-10">Packages</h2>
      <div class="grid md:grid-cols-3 gap-px bg-white/5 rounded-lg overflow-hidden">
        <div class="bg-[#0a0a0a] p-6">
          <code class="text-[13px] text-ag-400">@tempo-agentgate/sdk</code>
          <p class="text-[14px] text-[#888] mt-2">Agent client. Auto 402→pay→retry, Privy wallet integration, batch calls.</p>
        </div>
        <div class="bg-[#0a0a0a] p-6">
          <code class="text-[13px] text-ag-400">@tempo-agentgate/middleware</code>
          <p class="text-[14px] text-[#888] mt-2">Hono middleware. Add <code class="text-[12px] text-[#ccc]">paywall()</code> to any route — that's the entire integration.</p>
        </div>
        <div class="bg-[#0a0a0a] p-6">
          <code class="text-[13px] text-ag-400">@tempo-agentgate/core</code>
          <p class="text-[14px] text-[#888] mt-2">Shared types, chain config, token addresses, payment verification.</p>
        </div>
      </div>
      <div class="mt-4">
        <div class="code-block rounded-lg px-5 py-3 text-[13px] inline-block">
          <span class="tok-const">$</span> bun add @tempo-agentgate/sdk @tempo-agentgate/middleware @tempo-agentgate/core
        </div>
      </div>
    </div>
  </section>

  <!-- Stack -->
  <section class="border-t border-white/5">
    <div class="max-w-6xl mx-auto px-6 py-20">
      <h2 class="text-2xl font-semibold tracking-tight mb-10">Stack</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-6 text-[14px]">
        <div>
          <div class="text-[#888] text-[12px] uppercase tracking-wider mb-2">Chain</div>
          <div class="font-medium">Tempo</div>
          <div class="text-[13px] text-[#666]">~2s finality, $0 gas</div>
        </div>
        <div>
          <div class="text-[#888] text-[12px] uppercase tracking-wider mb-2">Wallets</div>
          <div class="font-medium">Privy</div>
          <div class="text-[13px] text-[#666]">Server wallets, no seed phrases</div>
        </div>
        <div>
          <div class="text-[#888] text-[12px] uppercase tracking-wider mb-2">Runtime</div>
          <div class="font-medium">Bun + Hono</div>
          <div class="text-[13px] text-[#666]">TypeScript, fast</div>
        </div>
        <div>
          <div class="text-[#888] text-[12px] uppercase tracking-wider mb-2">Token</div>
          <div class="font-medium">pathUSD</div>
          <div class="text-[13px] text-[#666]">Stablecoin on Tempo</div>
        </div>
        <div>
          <div class="text-[#888] text-[12px] uppercase tracking-wider mb-2">Auth</div>
          <div class="font-medium">Passkeys</div>
          <div class="text-[13px] text-[#666]">Tempo-native P256/WebAuthn</div>
        </div>
        <div>
          <div class="text-[#888] text-[12px] uppercase tracking-wider mb-2">Discovery</div>
          <div class="font-medium">.well-known</div>
          <div class="text-[13px] text-[#666]">Standard service manifest</div>
        </div>
        <div>
          <div class="text-[#888] text-[12px] uppercase tracking-wider mb-2">Payments</div>
          <div class="font-medium">HTTP 402</div>
          <div class="text-[13px] text-[#666]">Finally using that status code</div>
        </div>
        <div>
          <div class="text-[#888] text-[12px] uppercase tracking-wider mb-2">On-chain</div>
          <div class="font-medium">viem</div>
          <div class="text-[13px] text-[#666]">Type-safe Ethereum interactions</div>
        </div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section class="border-t border-white/5">
    <div class="max-w-6xl mx-auto px-6 py-20 text-center">
      <h2 class="text-2xl font-semibold tracking-tight mb-3">Start building</h2>
      <p class="text-[14px] text-[#888] mb-8 max-w-md mx-auto">Monetize your API in minutes. No signup, no API keys — just middleware and a wallet address.</p>
      <div class="flex items-center gap-3 justify-center">
        <a href="/providers" class="text-sm bg-white text-black px-5 py-2.5 rounded-md font-medium hover:bg-white/90 transition">Register your API</a>
        <a href="https://github.com/ss251/agentgate" class="text-sm text-[#888] border border-white/10 px-5 py-2.5 rounded-md font-medium hover:text-white hover:border-white/20 transition">View source</a>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="border-t border-white/5">
    <div class="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-[13px] text-[#555]">
      <div>Built for <a href="https://canteenapp-tempo.notion.site/" class="text-[#888] hover:text-white transition">Canteen × Tempo Hackathon</a> · Track 3: AI Agents</div>
      <div class="flex items-center gap-4">
        <a href="/dashboard" class="hover:text-white transition">Dashboard</a>
        <a href="/providers" class="hover:text-white transition">Marketplace</a>
        <a href="/auth/passkey" class="hover:text-white transition">Passkeys</a>
        <a href="/.well-known/x-agentgate.json" class="hover:text-white transition">API</a>
        <a href="https://tempo.xyz" class="hover:text-white transition">Tempo</a>
        <a href="https://privy.io" class="hover:text-white transition">Privy</a>
      </div>
    </div>
  </footer>

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
