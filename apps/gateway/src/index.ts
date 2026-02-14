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
    <div style="padding:20px 24px;background:var(--surface);border:1px solid var(--border);border-radius:8px;transition:border-color 0.3s;" onmouseover="this.style.borderColor='#3d4d00'" onmouseout="this.style.borderColor='var(--border)'">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
        <span style="font-size:15px;font-weight:500;">${p.name}</span>
        <span class="mono" style="font-size:13px;color:var(--accent);">${p.price} pathUSD</span>
      </div>
      <p style="font-size:13px;color:var(--text-2);margin-bottom:8px;">${p.description}</p>
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-3);">
        <span class="mono" style="padding:2px 8px;background:var(--border);border-radius:4px;">${p.category}</span>
        <span class="mono">${p.endpoint}</span>
      </div>
      <div class="mono" style="font-size:11px;color:var(--text-3);margin-top:8px;">Wallet: ${p.walletAddress.slice(0, 10)}… · ${new Date(p.registeredAt).toLocaleDateString()}</div>
    </div>
  `).join('');

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentGate — Provider Marketplace</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #050505; --surface: #0c0c0c; --border: #1a1a1a;
      --text: #e8e8e8; --text-2: #737373; --text-3: #454545;
      --accent: #c8ff00; --accent-dim: #3d4d00;
    }
    body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    code, .mono { font-family: 'DM Mono', monospace; }
    .serif { font-family: 'Instrument Serif', serif; }
    a { color: inherit; text-decoration: none; }
    input, select { font-family: 'DM Mono', monospace; }
    body::after {
      content: ''; position: fixed; inset: 0; z-index: 9999; pointer-events: none; opacity: 0.015;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    }
    @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr !important; } }
  </style>
</head>
<body>

  <!-- Nav -->
  <nav style="position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(5,5,5,0.8);border-bottom:1px solid var(--border);">
    <div style="max-width:1100px;margin:0 auto;padding:0 24px;height:52px;display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:32px;">
        <a href="/" class="mono" style="font-size:15px;font-weight:600;letter-spacing:-0.02em;">agentgate</a>
        <div style="display:flex;gap:24px;font-size:13px;color:var(--text-2);">
          <a href="/" style="transition:color 0.2s;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-2)'">Home</a>
          <a href="/dashboard" style="transition:color 0.2s;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-2)'">Dashboard</a>
          <a href="/.well-known/x-agentgate.json" style="transition:color 0.2s;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-2)'">API</a>
        </div>
      </div>
    </div>
  </nav>

  <div style="max-width:1100px;margin:0 auto;padding:60px 24px;">

    <!-- Header -->
    <div style="margin-bottom:48px;">
      <p class="mono" style="font-size:12px;color:var(--accent);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px;">Provider Marketplace</p>
      <h1 style="font-size:36px;font-weight:300;letter-spacing:-0.03em;margin-bottom:8px;">
        List your API. <span class="serif" style="font-style:italic;">Get paid in stablecoins.</span>
      </h1>
      <p style="font-size:15px;color:var(--text-2);max-width:520px;">Register your endpoint and AI agents can discover and pay for it automatically via HTTP 402.</p>
    </div>

    <!-- Registration Form -->
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:28px;margin-bottom:48px;">
      <p style="font-size:14px;font-weight:500;margin-bottom:20px;">Register your API</p>
      <form id="registerForm">
        <div class="grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
          <div>
            <label style="display:block;font-size:12px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Service Name *</label>
            <input name="name" required placeholder="My LLM API" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:13px;color:var(--text);outline:none;transition:border-color 0.2s;" onfocus="this.style.borderColor='var(--accent-dim)'" onblur="this.style.borderColor='var(--border)'">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Endpoint URL *</label>
            <input name="endpoint" required placeholder="https://my-api.com/inference" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:13px;color:var(--text);outline:none;transition:border-color 0.2s;" onfocus="this.style.borderColor='var(--accent-dim)'" onblur="this.style.borderColor='var(--border)'">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Price (pathUSD) *</label>
            <input name="price" required placeholder="0.01" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:13px;color:var(--text);outline:none;transition:border-color 0.2s;" onfocus="this.style.borderColor='var(--accent-dim)'" onblur="this.style.borderColor='var(--border)'">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Category</label>
            <select name="category" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:13px;color:var(--text);outline:none;cursor:pointer;">
              <option value="inference">Inference</option>
              <option value="data">Data</option>
              <option value="compute">Compute</option>
              <option value="storage">Storage</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:12px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Description</label>
          <input name="description" placeholder="GPT-4 proxy with function calling support" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:13px;color:var(--text);outline:none;transition:border-color 0.2s;" onfocus="this.style.borderColor='var(--accent-dim)'" onblur="this.style.borderColor='var(--border)'">
        </div>
        <div style="margin-bottom:20px;">
          <label style="display:block;font-size:12px;color:var(--text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Wallet Address *</label>
          <input name="walletAddress" required placeholder="0x..." style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:13px;color:var(--text);outline:none;transition:border-color 0.2s;" onfocus="this.style.borderColor='var(--accent-dim)'" onblur="this.style.borderColor='var(--border)'">
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <button type="submit" style="font-family:'Outfit',sans-serif;font-size:13px;padding:10px 20px;background:var(--accent);color:#000;font-weight:500;border:none;border-radius:6px;cursor:pointer;transition:opacity 0.2s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">Register →</button>
          <span id="formStatus" style="font-size:13px;"></span>
        </div>
      </form>
    </div>

    <!-- Registered Providers -->
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:20px;">
      <p style="font-size:14px;font-weight:500;">Registered services</p>
      <span class="mono" style="font-size:12px;color:var(--text-3);">${registeredProviders.length} total</span>
    </div>
    ${registeredProviders.length === 0
      ? '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:40px;text-align:center;color:var(--text-3);font-size:14px;">No external providers registered yet. Be the first.</div>'
      : '<div class="grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' + providerCards + '</div>'}

    <!-- Footer -->
    <div style="margin-top:48px;padding-top:20px;border-top:1px solid var(--border);display:flex;gap:20px;font-size:12px;color:var(--text-3);">
      <a href="/" style="transition:color 0.2s;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-3)'">Home</a>
      <a href="/dashboard" style="transition:color 0.2s;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-3)'">Dashboard</a>
      <a href="/auth/passkey" style="transition:color 0.2s;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-3)'">Passkeys</a>
      <a href="/.well-known/x-agentgate.json" style="transition:color 0.2s;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-3)'">API</a>
    </div>

  </div>

  <script>
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form));
      const status = document.getElementById('formStatus');
      status.textContent = 'Registering...';
      status.style.color = '#ffd43b';
      try {
        const res = await fetch('/api/providers/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (res.ok) {
          status.textContent = '✓ Registered!';
          status.style.color = '#00e87b';
          setTimeout(() => location.reload(), 1000);
        } else {
          const err = await res.json();
          status.textContent = '✗ ' + (err.error || 'Failed');
          status.style.color = '#ff4040';
        }
      } catch (err) {
        status.textContent = '✗ Network error';
        status.style.color = '#ff4040';
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
      <tr>
        <td class="mono" style="font-size:12px;"><a href="https://explorer.moderato.tempo.xyz/tx/${tx.txHash}" target="_blank" style="color:var(--text-2);text-decoration:none;border-bottom:1px dashed var(--text-3);transition:color 0.2s;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-2)'">${tx.txHash.slice(0, 10)}…${tx.txHash.slice(-6)}</a></td>
        <td class="mono" style="font-size:12px;color:var(--text-2);">${tx.from.slice(0, 10)}…</td>
        <td style="color:var(--accent);font-weight:500;">${tx.amount} pathUSD</td>
        <td><span class="endpoint-tag">${tx.endpoint}</span></td>
        <td style="color:var(--text-3);font-size:12px;">${new Date(tx.timestamp).toLocaleTimeString()}</td>
      </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard — AgentGate</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Instrument+Serif:ital@0;1&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #050505; --surface: #0c0c0c; --border: #1a1a1a;
      --text: #e8e8e8; --text-2: #737373; --text-3: #454545;
      --accent: #c8ff00; --accent-dim: #3d4d00;
      --red: #ff4040; --green: #00e87b;
    }
    body {
      font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text);
      min-height: 100vh; -webkit-font-smoothing: antialiased;
      background-image:
        radial-gradient(ellipse 80% 60% at 50% -20%, rgba(200,255,0,0.03), transparent),
        radial-gradient(ellipse 60% 40% at 80% 100%, rgba(200,255,0,0.02), transparent);
    }
    .mono { font-family: 'DM Mono', monospace; }
    .serif { font-family: 'Instrument Serif', serif; }

    /* Grain overlay */
    body::after {
      content: ''; position: fixed; inset: 0; z-index: 9999; pointer-events: none; opacity: 0.015;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    }

    .container { max-width: 1100px; margin: 0 auto; padding: 40px 24px; position: relative; z-index: 1; }

    /* Nav */
    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 0; margin-bottom: 48px; border-bottom: 1px solid var(--border);
    }
    nav a { color: var(--text-2); text-decoration: none; font-size: 14px; transition: color 0.2s; }
    nav a:hover { color: var(--text); }
    .nav-brand { font-family: 'DM Mono', monospace; font-size: 14px; color: var(--text); letter-spacing: -0.5px; }
    .nav-links { display: flex; gap: 24px; align-items: center; }

    /* Header */
    .dash-header { margin-bottom: 48px; }
    .dash-header h1 { font-family: 'Instrument Serif', serif; font-size: clamp(32px, 5vw, 48px); font-weight: 400; line-height: 1.1; margin-bottom: 8px; }
    .dash-header h1 span { color: var(--accent); }
    .status-pill {
      display: inline-flex; align-items: center; gap: 6px;
      background: rgba(200,255,0,0.08); border: 1px solid rgba(200,255,0,0.2);
      padding: 4px 12px; border-radius: 100px; font-size: 12px; color: var(--accent);
      font-family: 'DM Mono', monospace;
    }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* Stat cards */
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 48px; }
    @media (max-width: 768px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
    .stat-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px;
      transition: border-color 0.3s;
    }
    .stat-card:hover { border-color: rgba(200,255,0,0.15); }
    .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-3); margin-bottom: 8px; font-family: 'DM Mono', monospace; }
    .stat-value { font-size: 28px; font-weight: 500; line-height: 1.2; }
    .stat-sub { font-size: 12px; color: var(--text-3); margin-top: 4px; font-family: 'DM Mono', monospace; }
    .stat-accent { color: var(--accent); }

    /* Section */
    .section { margin-bottom: 48px; }
    .section-header {
      display: flex; align-items: center; justify-content: space-between;
      padding-bottom: 16px; margin-bottom: 0; border-bottom: 1px solid var(--border);
    }
    .section-title { font-family: 'DM Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: var(--text-3); }
    .section-action { font-size: 13px; color: var(--accent); text-decoration: none; font-family: 'DM Mono', monospace; }
    .section-action:hover { text-decoration: underline; }

    /* Endpoints */
    .endpoint-row {
      display: flex; align-items: center; justify-content: space-between; padding: 16px 0;
      border-bottom: 1px solid var(--border);
    }
    .endpoint-row:last-child { border-bottom: none; }
    .endpoint-method {
      font-family: 'DM Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
      color: var(--accent); background: rgba(200,255,0,0.08); border: 1px solid rgba(200,255,0,0.15);
      padding: 2px 8px; border-radius: 4px; margin-right: 12px;
    }
    .endpoint-path { font-family: 'DM Mono', monospace; font-size: 14px; }
    .endpoint-desc { color: var(--text-2); font-size: 13px; margin-left: 16px; }
    .endpoint-price { font-family: 'DM Mono', monospace; font-size: 13px; color: var(--accent); white-space: nowrap; }
    .endpoint-tag {
      font-family: 'DM Mono', monospace; font-size: 10px;
      background: rgba(200,255,0,0.06); border: 1px solid var(--border);
      padding: 2px 8px; border-radius: 4px; color: var(--text-2);
    }

    /* Privy section */
    .privy-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--border); border-radius: 12px; overflow: hidden; margin-top: 0; }
    @media (max-width: 640px) { .privy-grid { grid-template-columns: 1fr; } }
    .privy-cell { background: var(--surface); padding: 24px; text-align: center; }
    .privy-val { font-size: 18px; font-weight: 500; margin-bottom: 4px; }
    .privy-label { font-size: 12px; color: var(--text-3); }

    /* Providers */
    .provider-row { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid var(--border); }
    .provider-row:last-child { border-bottom: none; }
    .provider-name { font-weight: 500; }
    .provider-desc { color: var(--text-2); font-size: 13px; margin-left: 12px; }
    .provider-cat {
      font-family: 'DM Mono', monospace; font-size: 10px; text-transform: uppercase;
      color: var(--text-3); border: 1px solid var(--border); padding: 2px 8px; border-radius: 4px; margin-left: 8px;
    }

    /* Transactions table */
    table { width: 100%; border-collapse: collapse; }
    th { font-family: 'DM Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-3); text-align: left; padding: 12px 0; border-bottom: 1px solid var(--border); }
    td { padding: 12px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    .empty-state { padding: 48px 0; text-align: center; color: var(--text-3); font-size: 14px; }

    /* Footer */
    .dash-footer { padding-top: 32px; border-top: 1px solid var(--border); display: flex; justify-content: center; gap: 24px; flex-wrap: wrap; }
    .dash-footer a { color: var(--text-3); text-decoration: none; font-size: 13px; transition: color 0.2s; }
    .dash-footer a:hover { color: var(--accent); }
  </style>
</head>
<body>
  <div class="container">
    <nav>
      <span class="nav-brand">agentgate</span>
      <div class="nav-links">
        <a href="/">Home</a>
        <a href="/providers">Providers</a>
        <a href="/.well-known/x-agentgate.json">Discovery</a>
        <a href="https://github.com/ss251/agentgate" target="_blank">GitHub</a>
      </div>
    </nav>

    <div class="dash-header">
      <h1>System <span>Dashboard</span></h1>
      <div style="display:flex;align-items:center;gap:16px;margin-top:12px;">
        <span class="status-pill"><span class="status-dot"></span>online</span>
        <span class="mono" style="font-size:12px;color:var(--text-3);">v${VERSION}</span>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value">${uptimeStr}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Requests</div>
        <div class="stat-value">${stats.totalRequests}</div>
        <div class="stat-sub">${stats.paidRequests} paid</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Revenue</div>
        <div class="stat-value stat-accent">${formatUnits(stats.totalRevenue, 6)}</div>
        <div class="stat-sub">pathUSD</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Wallet Balance</div>
        <div class="stat-value">${balanceStr}</div>
        <div class="stat-sub">${PROVIDER_ADDRESS.slice(0, 10)}…</div>
      </div>
    </div>

    <!-- Privy -->
    <div class="section">
      <div class="section-header">
        <span class="section-title" style="display:flex;align-items:center;gap:8px;">
          <img src="https://framerusercontent.com/images/oPqxoNxeHrQ9qgbjTUGuANdXdQ.png" alt="Privy" style="width:16px;height:16px;border-radius:3px;">
          Wallet Infrastructure — Privy
        </span>
        <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--accent);border:1px solid rgba(200,255,0,0.2);padding:2px 8px;border-radius:4px;">server wallets</span>
      </div>
      <div class="privy-grid">
        <div class="privy-cell">
          <div class="privy-val stat-accent">0-click</div>
          <div class="privy-label">wallet creation</div>
        </div>
        <div class="privy-cell">
          <div class="privy-val">no seed phrases</div>
          <div class="privy-label">Privy manages keys</div>
        </div>
        <div class="privy-cell">
          <div class="privy-val">fee sponsored</div>
          <div class="privy-label">agents pay only pathUSD</div>
        </div>
      </div>
      <div style="padding:12px 0;font-size:12px;color:var(--text-3);font-family:'DM Mono',monospace;">
        POST /api/wallets/create → instant wallet &nbsp;·&nbsp; GET /api/wallets/:id/balance → on-chain check
      </div>
    </div>

    <!-- Endpoints -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Paid Endpoints</span>
      </div>
      <div class="endpoint-row">
        <div style="display:flex;align-items:center;">
          <span class="endpoint-method">post</span>
          <span class="endpoint-path">/api/chat</span>
          <span class="endpoint-desc">LLM Chat — Groq llama-3.3-70b</span>
        </div>
        <span class="endpoint-price">0.005 pathUSD</span>
      </div>
      <div class="endpoint-row">
        <div style="display:flex;align-items:center;">
          <span class="endpoint-method">post</span>
          <span class="endpoint-path">/api/execute</span>
          <span class="endpoint-desc">Run TypeScript, Python, or shell</span>
        </div>
        <span class="endpoint-price">0.01 pathUSD</span>
      </div>
      <div class="endpoint-row">
        <div style="display:flex;align-items:center;">
          <span class="endpoint-method">post</span>
          <span class="endpoint-path">/api/scrape</span>
          <span class="endpoint-desc">Fetch and extract content from URLs</span>
        </div>
        <span class="endpoint-price">0.005 pathUSD</span>
      </div>
      <div class="endpoint-row">
        <div style="display:flex;align-items:center;">
          <span class="endpoint-method">post</span>
          <span class="endpoint-path">/api/deploy</span>
          <span class="endpoint-desc">Deploy HTML and get a live URL</span>
        </div>
        <span class="endpoint-price">0.05 pathUSD</span>
      </div>
    </div>

    <!-- External Providers -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">External Providers</span>
        <a href="/providers" class="section-action">register yours →</a>
      </div>
      ${registeredProviders.length === 0
        ? '<div class="empty-state">No external providers yet. <a href="/providers" style="color:var(--accent);">Register your API</a> to start earning.</div>'
        : registeredProviders.slice(0, 5).map(p => `
          <div class="provider-row">
            <div style="display:flex;align-items:center;">
              <span class="provider-name">${p.name}</span>
              <span class="provider-desc">${p.description}</span>
              <span class="provider-cat">${p.category}</span>
            </div>
            <span class="endpoint-price">${p.price} pathUSD</span>
          </div>`).join('')}
    </div>

    <!-- Transactions -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Recent Transactions</span>
      </div>
      ${stats.recentTransactions.length === 0
        ? '<div class="empty-state">No transactions yet. Waiting for agents to call paid endpoints…</div>'
        : `<table>
        <thead>
          <tr>
            <th>Tx Hash</th>
            <th>From</th>
            <th>Amount</th>
            <th>Endpoint</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>${txRows}</tbody>
      </table>`}
    </div>

    <div class="dash-footer">
      <a href="/auth/passkey">Passkey Auth</a>
      <a href="https://tempo.xyz" target="_blank">Tempo</a>
      <a href="https://privy.io" target="_blank">Privy</a>
      <a href="/providers">Marketplace</a>
      <a href="/.well-known/x-agentgate.json">Discovery</a>
      <a href="/api/health">Health</a>
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
  <title>AgentGate — HTTP 402 for AI Agents</title>
  <meta name="description" content="AI agents pay for APIs with stablecoins on Tempo. HTTP 402 the way it was meant to be used.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Instrument+Serif:ital@0;1&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #050505; --surface: #0c0c0c; --border: #1a1a1a;
      --text: #e8e8e8; --text-2: #737373; --text-3: #454545;
      --accent: #c8ff00; --accent-dim: #3d4d00;
      --red: #ff4040; --green: #00e87b;
    }
    html { scroll-behavior: smooth; }
    body {
      font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text);
      min-height: 100vh; -webkit-font-smoothing: antialiased;
      background-image:
        radial-gradient(ellipse 80% 60% at 50% -20%, rgba(200,255,0,0.03), transparent),
        radial-gradient(ellipse 60% 40% at 80% 100%, rgba(200,255,0,0.02), transparent);
    }
    code, pre, .mono { font-family: 'DM Mono', monospace; }
    .serif { font-family: 'Instrument Serif', serif; }

    /* Grain overlay */
    body::after {
      content: ''; position: fixed; inset: 0; z-index: 9999; pointer-events: none; opacity: 0.015;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    }

    /* Animations */
    @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes typeIn { from { width: 0; } to { width: 100%; } }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    @keyframes slideIn { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); } }
    .fade-up { animation: fadeUp 0.6s ease-out both; }
    .fade-up-1 { animation-delay: 0.1s; }
    .fade-up-2 { animation-delay: 0.2s; }
    .fade-up-3 { animation-delay: 0.3s; }
    .fade-up-4 { animation-delay: 0.4s; }

    /* Terminal */
    .terminal { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .terminal-bar { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
    .terminal-dot { width: 10px; height: 10px; border-radius: 50%; }
    .terminal-body { padding: 20px 24px; font-size: 13px; line-height: 1.8; overflow-x: auto; }
    .terminal-body .prompt { color: var(--accent); }
    .terminal-body .comment { color: var(--text-3); font-style: italic; }
    .terminal-body .status-402 { color: var(--red); font-weight: 500; }
    .terminal-body .status-200 { color: var(--green); font-weight: 500; }
    .terminal-body .header { color: var(--text-2); }
    .terminal-body .string { color: #f0a; }
    .terminal-body .dim { color: var(--text-3); }

    /* Flow diagram */
    .flow-step {
      position: relative; padding: 24px 28px; background: var(--surface);
      border: 1px solid var(--border); transition: border-color 0.3s;
    }
    .flow-step:hover { border-color: var(--accent-dim); }
    .flow-num {
      position: absolute; top: -1px; right: -1px; font-size: 11px; padding: 4px 10px;
      background: var(--border); color: var(--text-2); font-family: 'DM Mono', monospace;
    }

    /* Endpoint row */
    .endpoint-row {
      display: grid; grid-template-columns: 1fr auto; gap: 16px;
      padding: 16px 0; border-bottom: 1px solid var(--border); align-items: center;
    }
    .endpoint-row:last-child { border-bottom: none; }
    .method { color: var(--accent); font-size: 11px; font-weight: 500; letter-spacing: 0.05em; }

    /* Code blocks */
    .code-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .code-tab {
      padding: 10px 20px; font-size: 12px; color: var(--text-2); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 8px;
    }
    .code-tab .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
    .code-body { padding: 20px 24px; font-size: 13px; line-height: 1.7; overflow-x: auto; white-space: pre; }
    .code-body .kw { color: #ff6b6b; }
    .code-body .str { color: #ffd43b; }
    .code-body .fn { color: #74c0fc; }
    .code-body .cm { color: var(--text-3); }
    .code-body .type { color: #b197fc; }

    /* Status badge */
    .badge {
      display: inline-flex; align-items: center; gap: 6px; font-size: 11px;
      padding: 4px 10px; border-radius: 100px; border: 1px solid;
    }
    .badge-live { color: var(--green); border-color: rgba(0,232,123,0.2); }
    .badge-live::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--green); }

    /* Nav */
    nav { position: sticky; top: 0; z-index: 100; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); background: rgba(5,5,5,0.8); border-bottom: 1px solid var(--border); }
    nav a { color: var(--text-2); text-decoration: none; font-size: 13px; transition: color 0.2s; }
    nav a:hover { color: var(--text); }

    /* Pkg cards */
    .pkg {
      padding: 20px 24px; background: var(--surface); border: 1px solid var(--border);
      transition: all 0.3s;
    }
    .pkg:hover { border-color: var(--accent-dim); transform: translateY(-2px); }

    a { color: inherit; text-decoration: none; }

    /* Responsive */
    @media (max-width: 768px) {
      .hero-title { font-size: 36px !important; }
      .grid-2 { grid-template-columns: 1fr !important; }
      .grid-3 { grid-template-columns: 1fr !important; }
      .hide-mobile { display: none !important; }
    }
  </style>
</head>
<body>

  <!-- Nav -->
  <nav>
    <div style="max-width:1100px;margin:0 auto;padding:0 24px;height:52px;display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:32px;">
        <a href="/" style="font-size:15px;font-weight:600;color:var(--text);letter-spacing:-0.02em;" class="mono">agentgate</a>
        <div style="display:flex;gap:24px;" class="hide-mobile">
          <a href="#flow">Protocol</a>
          <a href="#endpoints">Endpoints</a>
          <a href="#code">Code</a>
          <a href="/dashboard">Dashboard</a>
          <a href="https://github.com/ss251/agentgate" target="_blank">GitHub ↗</a>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:16px;">
        <span class="badge badge-live mono">Testnet</span>
      </div>
    </div>
  </nav>

  <!-- Hero -->
  <section style="max-width:1100px;margin:0 auto;padding:100px 24px 80px;">
    <div style="max-width:720px;">
      <p class="mono fade-up" style="font-size:12px;color:var(--accent);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:20px;">
        HTTP 402 Payment Required
      </p>
      <h1 class="fade-up fade-up-1 hero-title" style="font-size:56px;font-weight:300;line-height:1.1;letter-spacing:-0.03em;margin-bottom:24px;">
        The internet has a <br><span class="serif" style="font-style:italic;font-weight:400;">payment status code.</span><br>
        We built the protocol.
      </h1>
      <p class="fade-up fade-up-2" style="font-size:17px;color:var(--text-2);line-height:1.6;max-width:520px;margin-bottom:36px;">
        AgentGate lets AI agents pay for any API with stablecoins on Tempo.
        No API keys. No subscriptions. One HTTP header.
      </p>
      <div class="fade-up fade-up-3" style="display:flex;gap:12px;align-items:center;">
        <a href="#code" style="font-size:13px;padding:10px 20px;background:var(--accent);color:#000;font-weight:500;border-radius:6px;transition:opacity 0.2s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">View integration</a>
        <a href="/.well-known/x-agentgate.json" class="mono" style="font-size:13px;padding:10px 20px;border:1px solid var(--border);border-radius:6px;transition:border-color 0.2s;" onmouseover="this.style.borderColor='#333'" onmouseout="this.style.borderColor='var(--border)'">discovery.json →</a>
      </div>
    </div>
  </section>

  <!-- Terminal: The 402 dance -->
  <section id="flow" style="max-width:1100px;margin:0 auto;padding:0 24px 80px;">
    <div class="terminal fade-up fade-up-4">
      <div class="terminal-bar">
        <div class="terminal-dot" style="background:#ff5f57;"></div>
        <div class="terminal-dot" style="background:#febc2e;"></div>
        <div class="terminal-dot" style="background:#28c840;"></div>
        <span class="mono" style="margin-left:8px;font-size:12px;color:var(--text-3);">http 402 flow</span>
      </div>
      <pre class="terminal-body mono" style="margin:0;"><span class="comment"># 1. agent calls a paid endpoint</span>
<span class="prompt">$</span> curl -X POST /api/execute \\
  -d '{"code": "console.log(42)"}'

<span class="comment"># 2. gateway responds with payment instructions</span>
<span class="status-402">HTTP/1.1 402 Payment Required</span>
<span class="header">X-Payment-Amount: 0.01</span>
<span class="header">X-Payment-Token: pathUSD</span>
<span class="header">X-Payment-Recipient: ${PROVIDER_ADDRESS.slice(0, 10)}…</span>

<span class="comment"># 3. agent pays pathUSD on Tempo (~2s finality)</span>
<span class="prompt">$</span> curl -X POST /api/execute \\
  -H <span class="string">"X-Payment: 0x00Df…:0.01:pathUSD:0xabc…def"</span> \\
  -d '{"code": "console.log(42)"}'

<span class="comment"># 4. payment verified on-chain, response returned</span>
<span class="status-200">HTTP/1.1 200 OK</span>
<span class="dim">{ "output": "42\\n", "exitCode": 0 }</span></pre>
    </div>
  </section>

  <!-- How it works — 3 steps -->
  <section style="max-width:1100px;margin:0 auto;padding:0 24px 80px;">
    <div class="grid-3" style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:8px;overflow:hidden;">
      <div class="flow-step">
        <div class="flow-num">01</div>
        <p class="mono" style="font-size:12px;color:var(--accent);margin-bottom:8px;">DISCOVER</p>
        <p style="font-size:14px;font-weight:400;margin-bottom:8px;">Find services</p>
        <p style="font-size:13px;color:var(--text-2);line-height:1.5;">Standard <code class="mono" style="font-size:12px;color:var(--text);">/.well-known/x-agentgate.json</code> lists APIs, prices, and wallet addresses. Zero signup.</p>
      </div>
      <div class="flow-step">
        <div class="flow-num">02</div>
        <p class="mono" style="font-size:12px;color:var(--accent);margin-bottom:8px;">PAY</p>
        <p style="font-size:14px;font-weight:400;margin-bottom:8px;">Send stablecoins</p>
        <p style="font-size:13px;color:var(--text-2);line-height:1.5;">Agent gets HTTP 402, transfers pathUSD on Tempo. Instant finality, no gas fees. Memo links payment to request.</p>
      </div>
      <div class="flow-step">
        <div class="flow-num">03</div>
        <p class="mono" style="font-size:12px;color:var(--accent);margin-bottom:8px;">USE</p>
        <p style="font-size:14px;font-weight:400;margin-bottom:8px;">Get the response</p>
        <p style="font-size:13px;color:var(--text-2);line-height:1.5;">Gateway verifies the tx on-chain and returns the API result. One round trip. Direct P2P — no intermediary cut.</p>
      </div>
    </div>
  </section>

  <!-- Live Endpoints -->
  <section id="endpoints" style="max-width:1100px;margin:0 auto;padding:0 24px 80px;">
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:24px;">
      <div>
        <h2 style="font-size:24px;font-weight:400;letter-spacing:-0.02em;">Live endpoints</h2>
        <p style="font-size:13px;color:var(--text-2);margin-top:4px;">Real services, real on-chain payments. Tempo testnet.</p>
      </div>
      <a href="/providers" class="mono" style="font-size:12px;color:var(--accent);">+ list yours</a>
    </div>
    <div style="border:1px solid var(--border);border-radius:8px;padding:4px 24px;">
      <div class="endpoint-row">
        <div>
          <span class="mono method">POST</span>
          <span class="mono" style="font-size:14px;margin-left:8px;">/api/chat</span>
          <span style="font-size:13px;color:var(--text-3);margin-left:12px;" class="hide-mobile">LLM inference · Groq llama-3.3-70b</span>
        </div>
        <span class="mono" style="font-size:13px;color:var(--text-2);">0.005 <span style="color:var(--text-3)">pathUSD</span></span>
      </div>
      <div class="endpoint-row">
        <div>
          <span class="mono method">POST</span>
          <span class="mono" style="font-size:14px;margin-left:8px;">/api/execute</span>
          <span style="font-size:13px;color:var(--text-3);margin-left:12px;" class="hide-mobile">Sandboxed code execution · TS, Python, Shell</span>
        </div>
        <span class="mono" style="font-size:13px;color:var(--text-2);">0.010 <span style="color:var(--text-3)">pathUSD</span></span>
      </div>
      <div class="endpoint-row">
        <div>
          <span class="mono method">POST</span>
          <span class="mono" style="font-size:14px;margin-left:8px;">/api/scrape</span>
          <span style="font-size:13px;color:var(--text-3);margin-left:12px;" class="hide-mobile">Web scraping · fetch and extract content</span>
        </div>
        <span class="mono" style="font-size:13px;color:var(--text-2);">0.005 <span style="color:var(--text-3)">pathUSD</span></span>
      </div>
      <div class="endpoint-row">
        <div>
          <span class="mono method">POST</span>
          <span class="mono" style="font-size:14px;margin-left:8px;">/api/deploy</span>
          <span style="font-size:13px;color:var(--text-3);margin-left:12px;" class="hide-mobile">Deploy HTML to a live URL</span>
        </div>
        <span class="mono" style="font-size:13px;color:var(--text-2);">0.050 <span style="color:var(--text-3)">pathUSD</span></span>
      </div>
    </div>
  </section>

  <!-- Code Examples -->
  <section id="code" style="max-width:1100px;margin:0 auto;padding:0 24px 80px;">
    <h2 style="font-size:24px;font-weight:400;letter-spacing:-0.02em;margin-bottom:24px;">Integration</h2>
    <div class="grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <!-- Agent side -->
      <div class="code-panel">
        <div class="code-tab"><div class="dot"></div> agent.ts <span style="margin-left:auto;font-size:11px;color:var(--text-3);">pay for APIs</span></div>
        <div class="code-body"><span class="kw">import</span> { AgentGateClient } <span class="kw">from</span> <span class="str">'@tempo-agentgate/sdk'</span>

<span class="kw">const</span> agent = <span class="kw">new</span> <span class="fn">AgentGateClient</span>({
  <span class="cm">// Privy server wallet — no seed phrases</span>
  privyAppId:     <span class="str">'your-app-id'</span>,
  privyAppSecret: <span class="str">'your-secret'</span>,
  walletId:       <span class="str">'privy-wallet-id'</span>,
})

<span class="cm">// SDK handles 402 → pay → retry</span>
<span class="kw">const</span> res = <span class="kw">await</span> agent.<span class="fn">fetch</span>(
  <span class="str">'${BASE_URL}/api/execute'</span>,
  {
    method: <span class="str">'POST'</span>,
    body: JSON.<span class="fn">stringify</span>({
      code: <span class="str">'console.log(42)'</span>,
      language: <span class="str">'typescript'</span>,
    })
  }
)</div>
      </div>
      <!-- Provider side -->
      <div class="code-panel">
        <div class="code-tab"><div class="dot"></div> server.ts <span style="margin-left:auto;font-size:11px;color:var(--text-3);">monetize your API</span></div>
        <div class="code-body"><span class="kw">import</span> { Hono } <span class="kw">from</span> <span class="str">'hono'</span>
<span class="kw">import</span> { paywall } <span class="kw">from</span> <span class="str">'@tempo-agentgate/middleware'</span>

<span class="kw">const</span> app = <span class="kw">new</span> <span class="fn">Hono</span>()

<span class="cm">// One line. Your API now accepts crypto.</span>
app.<span class="fn">use</span>(<span class="str">'/api/*'</span>, <span class="fn">paywall</span>({
  recipientAddress: <span class="str">'0xYourWallet'</span>,
  token: <span class="str">'pathUSD'</span>,
  pricing: {
    <span class="str">'POST /api/generate'</span>: {
      amount: <span class="str">'0.02'</span>,
    }
  }
}))

app.<span class="fn">post</span>(<span class="str">'/api/generate'</span>, (c) =&gt;
  c.<span class="fn">json</span>({ result: <span class="str">'...'</span> })
)</div>
      </div>
    </div>
  </section>

  <!-- Packages -->
  <section style="max-width:1100px;margin:0 auto;padding:0 24px 80px;">
    <h2 style="font-size:24px;font-weight:400;letter-spacing:-0.02em;margin-bottom:24px;">npm packages</h2>
    <div class="grid-3" style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px;">
      <div class="pkg">
        <code class="mono" style="font-size:13px;color:var(--accent);">@tempo-agentgate/sdk</code>
        <p style="font-size:13px;color:var(--text-2);margin-top:8px;line-height:1.5;">Agent client. Auto 402→pay→retry. Supports raw private keys and Privy server wallets.</p>
      </div>
      <div class="pkg">
        <code class="mono" style="font-size:13px;color:var(--accent);">@tempo-agentgate/middleware</code>
        <p style="font-size:13px;color:var(--text-2);margin-top:8px;line-height:1.5;">Hono middleware. One function call to paywall any route with on-chain verification.</p>
      </div>
      <div class="pkg">
        <code class="mono" style="font-size:13px;color:var(--accent);">@tempo-agentgate/core</code>
        <p style="font-size:13px;color:var(--text-2);margin-top:8px;line-height:1.5;">Shared types, Tempo chain config, stablecoin addresses, payment verification utils.</p>
      </div>
    </div>
    <div class="terminal" style="display:inline-block;">
      <div style="padding:12px 20px;">
        <code class="mono" style="font-size:13px;"><span style="color:var(--accent);">$</span> bun add @tempo-agentgate/sdk @tempo-agentgate/middleware</code>
      </div>
    </div>
  </section>

  <!-- Stack — horizontal compact -->
  <section style="max-width:1100px;margin:0 auto;padding:0 24px 80px;">
    <div style="border:1px solid var(--border);border-radius:8px;padding:24px 28px;">
      <p style="font-size:12px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:20px;" class="mono">Built with</p>
      <div style="display:flex;flex-wrap:wrap;gap:40px;align-items:center;">
        <a href="https://tempo.xyz" target="_blank" style="display:flex;align-items:center;gap:10px;text-decoration:none;">
          <img src="https://tempo.xyz/favicon.ico" alt="Tempo" style="width:24px;height:24px;border-radius:4px;">
          <div><span style="font-size:14px;font-weight:500;">Tempo</span> <span style="font-size:12px;color:var(--text-3);margin-left:4px;">~2s finality · $0 gas · pathUSD · passkeys</span></div>
        </a>
        <a href="https://privy.io" target="_blank" style="display:flex;align-items:center;gap:10px;text-decoration:none;">
          <img src="https://framerusercontent.com/images/oPqxoNxeHrQ9qgbjTUGuANdXdQ.png" alt="Privy" style="width:24px;height:24px;border-radius:4px;">
          <div><span style="font-size:14px;font-weight:500;">Privy</span> <span style="font-size:12px;color:var(--text-3);margin-left:4px;">server wallets · fee sponsorship</span></div>
        </a>
        <a href="https://viem.sh" target="_blank" style="display:flex;align-items:center;gap:10px;text-decoration:none;">
          <img src="https://viem.sh/icon-light.png" alt="viem" style="width:24px;height:24px;border-radius:4px;">
          <div><span style="font-size:14px;font-weight:500;">viem</span> <span style="font-size:12px;color:var(--text-3);margin-left:4px;">on-chain interactions</span></div>
        </a>
        <div style="display:flex;align-items:center;gap:10px;">
          <img src="https://bun.sh/logo.svg" alt="Bun" style="width:24px;height:24px;">
          <div><span style="font-size:14px;font-weight:500;">Bun + Hono</span> <span style="font-size:12px;color:var(--text-3);margin-left:4px;">runtime</span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section style="max-width:1100px;margin:0 auto;padding:0 24px 100px;text-align:center;">
    <p class="serif" style="font-size:32px;font-style:italic;font-weight:400;letter-spacing:-0.02em;margin-bottom:12px;">
      HTTP 402 was reserved in 1997<br>for "future use."
    </p>
    <p style="font-size:15px;color:var(--text-2);margin-bottom:28px;">The future is autonomous agents with wallets.</p>
    <div style="display:flex;gap:12px;justify-content:center;">
      <a href="/providers" style="font-size:13px;padding:10px 20px;background:var(--accent);color:#000;font-weight:500;border-radius:6px;display:inline-flex;align-items:center;">List your API</a>
      <a href="https://github.com/ss251/agentgate" style="font-size:13px;padding:10px 20px;border:1px solid var(--border);border-radius:6px;color:var(--text-2);display:inline-flex;align-items:center;">View source ↗</a>
    </div>
  </section>

  <!-- Footer -->
  <footer style="border-top:1px solid var(--border);">
    <div style="max-width:1100px;margin:0 auto;padding:20px 24px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;font-size:12px;color:var(--text-3);">
      <span>Built for <a href="https://canteenapp-tempo.notion.site/" style="color:var(--text-2);">Canteen × Tempo Hackathon</a> · Track 3: AI Agents & Automation</span>
      <div style="display:flex;gap:20px;">
        <a href="/dashboard" style="color:var(--text-3);">Dashboard</a>
        <a href="/providers" style="color:var(--text-3);">Marketplace</a>
        <a href="/.well-known/x-agentgate.json" style="color:var(--text-3);">API</a>
        <a href="https://tempo.xyz" style="color:var(--text-3);">Tempo</a>
        <a href="https://privy.io" style="color:var(--text-3);">Privy</a>
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
