import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { paywall } from '@agentgate/middleware';
import { STABLECOINS } from '@agentgate/core';
import { parse as parseHTML } from 'node-html-parser';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Address } from 'viem';

// ─── Config ──────────────────────────────────────────────────────
const PROVIDER_ADDRESS = (process.env.PROVIDER_ADDRESS ?? '0x00DfEe79B7fd7aEF0312E06da8E1d60a5957F9Cf') as Address;
const PORT = parseInt(process.env.PORT ?? '3402', 10);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const SITES_DIR = join(import.meta.dir, '..', '..', '..', '.sites');

// Ensure sites directory exists
mkdirSync(SITES_DIR, { recursive: true });

// ─── App ─────────────────────────────────────────────────────────
const app = new Hono();

app.use('*', cors());
app.use('*', logger());

// ─── Service Discovery ──────────────────────────────────────────
app.get('/.well-known/x-agentgate.json', (c) =>
  c.json({
    name: 'AgentGate Gateway',
    version: '0.1.0',
    chain: { id: 42431, name: 'Tempo Testnet' },
    token: { symbol: 'pathUSD', address: STABLECOINS.pathUSD.address, decimals: 6 },
    recipient: PROVIDER_ADDRESS,
    endpoints: [
      { method: 'POST', path: '/api/execute', price: '0.01', description: 'Code Execution — run TypeScript, Python, or shell code' },
      { method: 'POST', path: '/api/scrape', price: '0.005', description: 'Web Scraping — fetch and extract readable content from a URL' },
      { method: 'POST', path: '/api/deploy', price: '0.05', description: 'Site Deployment — deploy HTML and get a live URL' },
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
      'POST /api/execute': { amount: '0.01', description: 'Code Execution' },
      'POST /api/scrape': { amount: '0.005', description: 'Web Scraping' },
      'POST /api/deploy': { amount: '0.05', description: 'Site Deployment' },
    },
    onPayment: async ({ from, amount, txHash, endpoint }) => {
      console.log(`💰 Payment received: ${amount} from ${from} for ${endpoint} (tx: ${txHash})`);
    },
  })
);

// ─── Code Execution Service ─────────────────────────────────────

app.post('/api/execute', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { code, language } = body;

  if (!code || typeof code !== 'string') {
    return c.json({ error: 'Missing required field: code' }, 400);
  }

  const lang = language ?? 'typescript';
  if (!['typescript', 'python', 'shell'].includes(lang)) {
    return c.json({ error: 'Unsupported language. Use: typescript, python, shell' }, 400);
  }

  const startTime = Date.now();

  try {
    let cmd: string[];
    let input: string | undefined;

    switch (lang) {
      case 'typescript':
        cmd = ['bun', '-e', code];
        break;
      case 'python':
        cmd = ['python3', '-c', code];
        break;
      case 'shell':
        cmd = ['sh', '-c', code];
        break;
      default:
        return c.json({ error: 'Unknown language' }, 400);
    }

    const proc = Bun.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: process.env.PATH },
    });

    // Timeout after 10 seconds
    const timeout = setTimeout(() => proc.kill(), 10000);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    return c.json({
      stdout: stdout.slice(0, 50000),
      stderr: stderr.slice(0, 10000),
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
    return c.json({ error: 'Missing required field: url' }, 400);
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AgentGate/1.0 (Web Scraper)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return c.json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` }, 502);
    }

    const html = await response.text();
    const root = parseHTML(html);

    // Remove script, style, nav, footer, header elements
    for (const tag of ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript']) {
      root.querySelectorAll(tag).forEach((el) => el.remove());
    }

    // Get title
    const titleEl = root.querySelector('title');
    const title = titleEl ? titleEl.text.trim() : '';

    // Get main content
    const mainEl = root.querySelector('main') || root.querySelector('article') || root.querySelector('body');
    let content = '';

    if (mainEl) {
      if (format === 'text') {
        content = mainEl.text.replace(/\s+/g, ' ').trim();
      } else {
        // Simple markdown-ish conversion
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
    return c.json({ error: `Scrape failed: ${err.message}` }, 500);
  }
});

function htmlToMarkdown(node: any): string {
  let result = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { // text
      result += child.text;
    } else if (child.nodeType === 1) { // element
      const tag = child.tagName?.toLowerCase();
      if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
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
    return c.json({ error: 'Missing required field: html' }, 400);
  }

  const deployId = crypto.randomUUID().slice(0, 8);
  const deployDir = join(SITES_DIR, deployId);
  mkdirSync(deployDir, { recursive: true });

  // If no <html> wrapper, add a basic one
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
    return c.json({ error: 'Site not found' }, 404);
  }

  const html = readFileSync(filePath, 'utf-8');
  return c.html(html);
});

app.get('/sites/:deployId/*', (c) => {
  const deployId = c.req.param('deployId');
  const rest = c.req.path.replace(`/sites/${deployId}/`, '');
  const filePath = join(SITES_DIR, deployId, rest);

  if (!existsSync(filePath)) {
    return c.json({ error: 'File not found' }, 404);
  }

  const content = readFileSync(filePath);
  return new Response(content);
});

// ─── Health + Info ───────────────────────────────────────────────
app.get('/', (c) =>
  c.json({
    service: 'AgentGate Gateway',
    version: '0.1.0',
    docs: '/.well-known/x-agentgate.json',
    endpoints: {
      'POST /api/execute': '0.01 pathUSD — Code Execution',
      'POST /api/scrape': '0.005 pathUSD — Web Scraping',
      'POST /api/deploy': '0.05 pathUSD — Site Deployment',
    },
  })
);

// ─── Start ───────────────────────────────────────────────────────
console.log(`🚀 AgentGate Gateway running on http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
