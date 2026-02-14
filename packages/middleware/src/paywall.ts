import { createMiddleware } from 'hono/factory';
import { createPublicClient, http } from 'viem';
import type { MiddlewareHandler } from 'hono';
import {
  type ServiceConfig,
  type PaymentRequired,
  type AgentRegistration,
  verifyPayment,
  TOKENS,
  DEFAULT_RPC_URL,
  DEFAULT_DECIMALS,
  tempoTestnet,
  createMemo,
  parseAmount,
  hashBody,
  generateNonce,
} from '@agentgate/core';

export interface PaywallConfig {
  wallet: `0x${string}`;
  token?: `0x${string}`;
  routes: Record<string, ServiceConfig>;
  rpcUrl?: string;
  expirySeconds?: number;
  serviceName?: string;
  serviceDescription?: string;
}

export function paywall(config: PaywallConfig): MiddlewareHandler {
  const token = config.token ?? TOKENS.pathUSD;
  const rpcUrl = config.rpcUrl ?? DEFAULT_RPC_URL;
  const expirySeconds = config.expirySeconds ?? 60;

  const publicClient = createPublicClient({
    chain: tempoTestnet,
    transport: http(rpcUrl),
  });

  // Build registration document
  const registration: AgentRegistration = {
    name: config.serviceName ?? 'AgentGate Service',
    description: config.serviceDescription ?? 'API services with on-chain payments',
    services: Object.entries(config.routes).map(([endpoint, svc]) => ({
      name: svc.description,
      endpoint,
      price: svc.price,
      token: (svc.token ?? token) as string,
      description: svc.description,
    })),
    x402Support: true,
    active: true,
    wallet: config.wallet,
  };

  return createMiddleware(async (c, next) => {
    // Serve registration at well-known path
    if (c.req.path === '/.well-known/agentgate.json') {
      return c.json(registration);
    }

    // Build route key: "METHOD /path"
    const routeKey = `${c.req.method} ${c.req.path}`;

    // Find matching route config
    const serviceConfig = config.routes[routeKey];
    if (!serviceConfig) {
      // Not a priced route, pass through
      await next();
      return;
    }

    const paymentTx = c.req.header('X-Payment-Tx');

    if (!paymentTx) {
      // No payment — return 402 Payment Required
      const body = c.req.method !== 'GET' ? await c.req.text() : '';
      const bodyH = await hashBody(body);
      const nonce = generateNonce();
      const expiry = Math.floor(Date.now() / 1000) + expirySeconds;
      const svcToken = serviceConfig.token ?? token;
      const amount = parseAmount(serviceConfig.price, DEFAULT_DECIMALS).toString();

      const memo = createMemo(routeKey, bodyH, nonce, expiry);

      const paymentRequired: PaymentRequired = {
        network: 'tempo',
        chainId: tempoTestnet.id,
        recipient: config.wallet,
        token: svcToken,
        amount,
        memo,
        expiry,
        endpoint: routeKey,
        description: serviceConfig.description,
      };

      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

      return c.json(paymentRequired, 402, {
        'X-Payment': encoded,
      });
    }

    // Payment header present — verify
    const txHash = paymentTx.startsWith('0x') ? paymentTx as `0x${string}` : `0x${paymentTx}` as `0x${string}`;

    // We need to reconstruct expected payment for verification
    // In a real system we'd store the nonce/memo server-side; for the hackathon
    // we verify the on-chain transfer matches recipient + amount + token
    const svcToken = serviceConfig.token ?? token;
    const amount = parseAmount(serviceConfig.price, DEFAULT_DECIMALS).toString();

    const expected: PaymentRequired = {
      network: 'tempo',
      chainId: tempoTestnet.id,
      recipient: config.wallet,
      token: svcToken,
      amount,
      memo: '0x0000000000000000000000000000000000000000000000000000000000000000',
      expiry: Math.floor(Date.now() / 1000) + expirySeconds, // generous expiry for verification
      endpoint: routeKey,
      description: serviceConfig.description,
    };

    const result = await verifyPayment(txHash, expected, publicClient as any);

    if (!result.valid) {
      return c.json({ error: 'Payment verification failed', details: result.error }, 402);
    }

    // Payment valid — continue
    c.set('paymentReceipt' as any, result.receipt);
    await next();

    // Add receipt header to response
    if (result.receipt) {
      c.header('X-Payment-Receipt', JSON.stringify({
        txHash: result.receipt.txHash,
        from: result.receipt.from,
        amount: result.receipt.amount.toString(),
      }));
    }
  });
}
