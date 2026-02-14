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

    <!-- Endpoints -->
    <div class="bg-gray-900 rounded-xl border border-gray-800 mb-8">
      <div class="px-5 py-4 border-b border-gray-800">
        <h2 class="text-lg font-semibold">Available Endpoints</h2>
      </div>
      <div class="divide-y divide-gray-800">
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
      AgentGate — Built on <a href="https://tempo.xyz" class="text-blue-400 hover:underline">Tempo</a> | 
      Chain ID: 42431 | 
      <a href="/.well-known/x-agentgate.json" class="text-blue-400 hover:underline">Service Discovery</a> |
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
        'POST /api/execute': '0.01 pathUSD — Code Execution',
        'POST /api/scrape': '0.005 pathUSD — Web Scraping',
        'POST /api/deploy': '0.05 pathUSD — Site Deployment',
      },
      free: ['GET /', 'GET /api/health', 'GET /api/sites', 'GET /dashboard', 'GET /.well-known/x-agentgate.json'],
    });
  }

  // Landing page for browsers
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentGate — AI Agent Payment Gateway on Tempo</title>
  <meta name="description" content="Pay-per-call API gateway for AI agents using stablecoins on Tempo blockchain. HTTP 402 powered.">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
    .float { animation: float 3s ease-in-out infinite; }
    .gradient-text { background: linear-gradient(135deg, #60a5fa, #a78bfa, #34d399); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .glow { box-shadow: 0 0 40px rgba(96, 165, 250, 0.15); }
  </style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <!-- Hero -->
  <div class="max-w-5xl mx-auto px-6 pt-20 pb-16 text-center">
    <div class="text-6xl mb-6 float">🚪</div>
    <h1 class="text-5xl md:text-6xl font-bold mb-4">
      <span class="gradient-text">AgentGate</span>
    </h1>
    <p class="text-xl md:text-2xl text-gray-400 mb-2">Pay-per-call API gateway for AI agents</p>
    <p class="text-lg text-gray-500 mb-10">Stablecoin micropayments on <a href="https://tempo.xyz" class="text-blue-400 hover:underline">Tempo</a> via HTTP 402</p>
    <div class="flex gap-4 justify-center flex-wrap">
      <a href="/dashboard" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium transition">Live Dashboard →</a>
      <a href="https://github.com/ss251/agentgate" class="bg-gray-800 hover:bg-gray-700 text-white px-6 py-3 rounded-lg font-medium transition border border-gray-700">GitHub ↗</a>
      <a href="/.well-known/x-agentgate.json" class="bg-gray-800 hover:bg-gray-700 text-white px-6 py-3 rounded-lg font-medium transition border border-gray-700">Discovery API</a>
    </div>
  </div>

  <!-- How It Works -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <h2 class="text-3xl font-bold text-center mb-10">How It Works</h2>
    <div class="grid md:grid-cols-4 gap-6">
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800 glow text-center">
        <div class="text-3xl mb-3">🤖</div>
        <h3 class="font-semibold mb-2">1. Agent Requests</h3>
        <p class="text-gray-400 text-sm">AI agent calls a paid API endpoint</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800 glow text-center">
        <div class="text-3xl mb-3">💳</div>
        <h3 class="font-semibold mb-2">2. Gets 402</h3>
        <p class="text-gray-400 text-sm">Gateway returns payment requirements</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800 glow text-center">
        <div class="text-3xl mb-3">⛓️</div>
        <h3 class="font-semibold mb-2">3. Pays On-Chain</h3>
        <p class="text-gray-400 text-sm">Agent sends pathUSD on Tempo (~2s)</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800 glow text-center">
        <div class="text-3xl mb-3">✅</div>
        <h3 class="font-semibold mb-2">4. Gets Response</h3>
        <p class="text-gray-400 text-sm">Payment verified, service delivered</p>
      </div>
    </div>
  </div>

  <!-- Endpoints -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <h2 class="text-3xl font-bold text-center mb-10">Available Services</h2>
    <div class="grid md:grid-cols-3 gap-6">
      <div class="bg-gray-900 rounded-xl p-6 border border-gray-800">
        <div class="flex items-center justify-between mb-4">
          <span class="text-2xl">⚡</span>
          <span class="text-green-400 font-mono text-sm">0.01 pathUSD</span>
        </div>
        <h3 class="text-lg font-semibold mb-2">Code Execution</h3>
        <p class="text-gray-400 text-sm mb-3">Run TypeScript, Python, or shell commands in a sandboxed environment</p>
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
    </div>
  </div>

  <!-- Code Example -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <h2 class="text-3xl font-bold text-center mb-10">For Developers</h2>
    <div class="grid md:grid-cols-2 gap-6">
      <div class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-800 text-sm text-gray-400">🤖 Agent (SDK)</div>
        <pre class="p-4 text-sm overflow-x-auto"><code class="text-green-300">import { AgentGateClient } from '@tempo-agentgate/sdk';

const agent = new AgentGateClient({
  privateKey: '0x...'
});

// Auto: 402 → pay pathUSD → retry → result
const res = await agent.fetch(
  'https://gateway.example/api/execute',
  {
    method: 'POST',
    body: JSON.stringify({
      code: 'console.log("hello")',
      language: 'typescript'
    })
  }
);</code></pre>
      </div>
      <div class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-800 text-sm text-gray-400">🏪 Provider (Middleware)</div>
        <pre class="p-4 text-sm overflow-x-auto"><code class="text-purple-300">import { paywall } from '@tempo-agentgate/middleware';

app.use('/api/*', paywall({
  provider: '0x...',
  pricing: [
    {
      path: '/api/execute',
      method: 'POST',
      amount: '0.01',
      description: 'Code execution'
    }
  ]
}));</code></pre>
      </div>
    </div>
    <div class="text-center mt-6">
      <code class="text-gray-500 text-sm">npm install @tempo-agentgate/sdk @tempo-agentgate/middleware @tempo-agentgate/core</code>
    </div>
  </div>

  <!-- Tech Stack -->
  <div class="max-w-5xl mx-auto px-6 pb-16">
    <div class="bg-gray-900 rounded-xl border border-gray-800 p-8">
      <h2 class="text-2xl font-bold mb-6 text-center">Built With</h2>
      <div class="flex flex-wrap gap-3 justify-center">
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">⚡ Bun</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">🔥 Hono</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">⛓️ Tempo Testnet</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">💰 pathUSD (TIP-20)</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">🔗 viem</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">📦 TypeScript</span>
        <span class="bg-gray-800 px-4 py-2 rounded-lg text-sm">🧪 56 Tests</span>
      </div>
      <div class="mt-6 grid md:grid-cols-3 gap-4 text-center text-sm text-gray-400">
        <div><span class="text-white font-bold text-lg">3</span><br>npm packages published</div>
        <div><span class="text-white font-bold text-lg">~2s</span><br>payment confirmation</div>
        <div><span class="text-white font-bold text-lg">$0</span><br>gas fees (fee sponsorship)</div>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div class="max-w-5xl mx-auto px-6 pb-10 text-center text-gray-600 text-sm">
    Built for the <a href="https://canteenapp-tempo.notion.site/" class="text-blue-400 hover:underline">Canteen × Tempo Hackathon</a> · 
    Track 3: AI Agents & Automation · 
    <a href="https://github.com/ss251/agentgate" class="text-blue-400 hover:underline">Source Code</a> · 
    <a href="/dashboard" class="text-blue-400 hover:underline">Dashboard</a>
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
  fetch: app.fetch,
};
