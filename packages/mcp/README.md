# @tempo-agentgate/mcp

MCP (Model Context Protocol) server for AgentGate — use AI agent paid endpoints from **Claude Desktop**, **Cursor**, **Windsurf**, or any MCP-compatible client.

## What is this?

AgentGate lets AI agents pay for API endpoints using stablecoins on Tempo blockchain via HTTP 402. This MCP server wraps the AgentGate gateway so any MCP client can use it as a tool — payments happen automatically on-chain.

## Tools

| Tool | Description | Cost |
|------|-------------|------|
| `execute_code` | Run TypeScript/Python/shell in a sandbox | 0.01 pathUSD |
| `scrape_url` | Extract content from any URL | 0.005 pathUSD |
| `agent_chat` | Query an LLM | 0.005 pathUSD |
| `deploy_site` | Deploy static HTML to a public URL | 0.05 pathUSD |
| `discover_services` | List available endpoints & prices | Free |
| `check_balance` | Check your pathUSD balance | Free |

## Setup

### 1. Install

```bash
bun add @tempo-agentgate/mcp
# or
npm install @tempo-agentgate/mcp
```

### 2. Get a wallet

You need a private key with pathUSD on Tempo testnet. Get testnet tokens from the [Tempo faucet](https://faucet.tempo.xyz).

### 3. Configure your MCP client

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentgate": {
      "command": "bunx",
      "args": ["@tempo-agentgate/mcp"],
      "env": {
        "AGENTGATE_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE",
        "AGENTGATE_GATEWAY_URL": "https://tempo-agentgategateway-production.up.railway.app"
      }
    }
  }
}
```

#### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "agentgate": {
      "command": "bunx",
      "args": ["@tempo-agentgate/mcp"],
      "env": {
        "AGENTGATE_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE"
      }
    }
  }
}
```

#### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "agentgate": {
      "command": "bunx",
      "args": ["@tempo-agentgate/mcp"],
      "env": {
        "AGENTGATE_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENTGATE_PRIVATE_KEY` | Yes | — | Hex private key (0x-prefixed) with pathUSD balance |
| `AGENTGATE_GATEWAY_URL` | No | Production gateway | Custom gateway URL |

## How payments work

1. Your MCP client calls a tool (e.g., `execute_code`)
2. The server sends the request to AgentGate gateway
3. Gateway responds with HTTP 402 (Payment Required)
4. SDK automatically sends pathUSD payment on Tempo blockchain
5. After payment confirms, request is retried and result returned

All payments are on Tempo testnet — no real money involved.

## Links

- [AgentGate GitHub](https://github.com/ss251/agentgate)
- [Live Gateway](https://tempo-agentgategateway-production.up.railway.app)
- [Dashboard](https://tempo-agentgategateway-production.up.railway.app/dashboard)
- [Tempo Network](https://tempo.xyz)
