#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentGateClient } from '@tempo-agentgate/sdk';
import { formatUnits, type Hex } from 'viem';

// ─── Configuration ───────────────────────────────────────────────

const GATEWAY_URL = process.env.AGENTGATE_GATEWAY_URL || 'https://tempo-agentgategateway-production.up.railway.app';
const PRIVATE_KEY = process.env.AGENTGATE_PRIVATE_KEY as Hex | undefined;

if (!PRIVATE_KEY) {
  console.error('Error: AGENTGATE_PRIVATE_KEY env var required (hex private key with 0x prefix)');
  console.error('Get testnet pathUSD from the gateway faucet first.');
  process.exit(1);
}

// ─── SDK Client ──────────────────────────────────────────────────

const client = new AgentGateClient({
  privateKey: PRIVATE_KEY,
  onPaymentEvent: (event) => {
    if (event.type === 'payment_confirmed') {
      console.error(`[agentgate] Payment confirmed: ${event.txHash}`);
    }
  },
});

// ─── Helper ──────────────────────────────────────────────────────

async function callEndpoint(path: string, body: Record<string, unknown>): Promise<string> {
  const url = `${GATEWAY_URL}${path}`;
  const res = await client.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AgentGate ${path} failed (${res.status}): ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;
  return JSON.stringify(data, null, 2);
}

// ─── MCP Server ──────────────────────────────────────────────────

const server = new McpServer({
  name: 'agentgate',
  version: '0.1.0',
});

// Tool: Execute Code
server.tool(
  'execute_code',
  'Execute TypeScript, Python, or shell code on a remote sandboxed server. Costs 0.01 pathUSD per call, paid automatically via Tempo blockchain.',
  {
    code: z.string().describe('The code to execute'),
    language: z.enum(['typescript', 'python', 'shell']).default('typescript').describe('Programming language'),
  },
  async ({ code, language }) => {
    try {
      const result = await callEndpoint('/api/execute', { code, language });
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: Scrape URL
server.tool(
  'scrape_url',
  'Scrape and extract content from any URL. Returns title, text content, links, and metadata. Costs 0.005 pathUSD per call.',
  {
    url: z.string().url().describe('The URL to scrape'),
    selector: z.string().optional().describe('Optional CSS selector to extract specific content'),
  },
  async ({ url, selector }) => {
    try {
      const body: Record<string, unknown> = { url };
      if (selector) body.selector = selector;
      const result = await callEndpoint('/api/scrape', body);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: Chat / LLM Query
server.tool(
  'agent_chat',
  'Send a query to an LLM via AgentGate. Costs 0.005 pathUSD per call.',
  {
    message: z.string().describe('The message/prompt to send'),
    model: z.string().optional().describe('Optional model preference'),
  },
  async ({ message, model }) => {
    try {
      const body: Record<string, unknown> = { message };
      if (model) body.model = model;
      const result = await callEndpoint('/api/chat', body);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: Deploy Site
server.tool(
  'deploy_site',
  'Deploy a static HTML site to a public URL. Costs 0.05 pathUSD per deployment.',
  {
    html: z.string().describe('The HTML content to deploy'),
    name: z.string().optional().describe('Optional site name/slug'),
  },
  async ({ html, name }) => {
    try {
      const body: Record<string, unknown> = { html };
      if (name) body.name = name;
      const result = await callEndpoint('/api/deploy', body);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: Discover Services
server.tool(
  'discover_services',
  'Discover available paid API endpoints on the AgentGate gateway, including prices and descriptions.',
  async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/.well-known/x-agentgate.json`);
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: Check Balance
server.tool(
  'check_balance',
  'Check your pathUSD wallet balance on Tempo testnet.',
  async () => {
    try {
      const balance = await client.getBalance('pathUSD');
      const formatted = formatUnits(balance, 6);
      return { content: [{ type: 'text' as const, text: `Balance: ${formatted} pathUSD` }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Start ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[agentgate-mcp] Server running on stdio');
  console.error(`[agentgate-mcp] Gateway: ${GATEWAY_URL}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
