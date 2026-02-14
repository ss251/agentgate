import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';
import type { Address, Hex, Chain } from 'viem';
import {
  verifyPayment,
  parsePaymentHeader,
  buildPaymentRequirement,
  type StablecoinSymbol,
  type PaymentRequirement,
  tempoTestnet,
} from '@agentgate/core';

export interface EndpointPricing {
  amount: string;       // human-readable, e.g. "0.01"
  description?: string;
}

export interface PaywallOptions {
  /** Provider's wallet address — where payments go */
  recipientAddress: Address;
  /** Which stablecoin to accept (default: pathUSD) */
  token?: StablecoinSymbol;
  /** Pricing per "METHOD /path" */
  pricing: Record<string, EndpointPricing>;
  /** Payment validity window in seconds (default: 300 = 5 min) */
  expirySeconds?: number;
  /** Chain config (default: Tempo testnet) */
  chain?: Chain;
  /** Custom RPC URL */
  rpcUrl?: string;
  /** Set of already-used tx hashes to prevent replay (in-memory default) */
  usedTxHashes?: Set<string>;
  /** Called after successful payment verification */
  onPayment?: (info: { from: Address; amount: bigint; txHash: Hex; endpoint: string }) => void | Promise<void>;
}

/**
 * Hono middleware: paywall()
 * 
 * Returns 402 with payment requirements if no valid payment header.
 * Verifies on-chain TIP-20 transfer if X-Payment header is present.
 * 
 * Usage:
 *   app.use('/api/*', paywall({ recipientAddress: '0x...', pricing: { 'POST /api/chat': { amount: '0.01' } } }));
 */
export function paywall(options: PaywallOptions): MiddlewareHandler {
  const {
    recipientAddress,
    token = 'pathUSD',
    pricing,
    expirySeconds = 300,
    chain = tempoTestnet,
    rpcUrl,
    usedTxHashes = new Set<string>(),
    onPayment,
  } = options;

  return createMiddleware(async (c, next) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const key = `${method} ${path}`;

    // Check if this endpoint has pricing
    const price = pricing[key];
    if (!price) {
      // No pricing = free endpoint
      return next();
    }

    // Check for payment header
    const paymentHeader = c.req.header('X-Payment');
    if (!paymentHeader) {
      // Return 402 with payment requirements
      const nonce = crypto.randomUUID();
      const expiry = Math.floor(Date.now() / 1000) + expirySeconds;
      const requirement = buildPaymentRequirement({
        recipientAddress,
        token,
        amount: price.amount,
        endpoint: key,
        nonce,
        expiry,
        chainId: chain.id,
        description: price.description,
      });

      return c.json(
        {
          error: 'Payment Required',
          payment: requirement,
          instructions: {
            header: 'X-Payment',
            format: '<txHash>:<chainId>',
            steps: [
              `Transfer ${price.amount} ${token} to ${recipientAddress}`,
              'Include the tx hash in X-Payment header as txHash:chainId',
              'Retry the original request',
            ],
          },
        },
        402
      );
    }

    // Parse and verify payment
    const parsed = parsePaymentHeader(paymentHeader);
    if (!parsed) {
      return c.json({ error: 'Invalid X-Payment header format. Expected: txHash:chainId' }, 400);
    }

    // Replay protection
    if (usedTxHashes.has(parsed.txHash)) {
      return c.json({ error: 'Transaction already used for a previous request' }, 409);
    }

    // Build requirement for verification
    // Note: in production, nonce/expiry should come from a server-side store
    // For hackathon, we verify the transfer amount and recipient only
    const requirement: PaymentRequirement = {
      recipientAddress,
      tokenAddress: (await import('@agentgate/core')).STABLECOINS[token].address,
      tokenSymbol: token,
      amountRequired: (await import('viem')).parseUnits(price.amount, 18).toString(),
      amountHuman: price.amount,
      endpoint: key,
      nonce: '', // not checked in verify for now
      expiry: Math.floor(Date.now() / 1000) + expirySeconds, // generous window
      chainId: chain.id,
      memo: '0x' as Hex,
    };

    const verification = await verifyPayment({
      txHash: parsed.txHash,
      requirement,
      chain,
      rpcUrl,
    });

    if (!verification.valid) {
      return c.json({ error: 'Payment verification failed', details: verification.error }, 402);
    }

    // Mark tx as used
    usedTxHashes.add(parsed.txHash);

    // Callback
    if (onPayment && verification.from) {
      await onPayment({
        from: verification.from,
        amount: verification.amount!,
        txHash: parsed.txHash,
        endpoint: key,
      });
    }

    // Attach payment info to context
    c.set('payment' as any, verification);

    return next();
  });
}

export type { PaymentRequirement, PaymentVerification } from '@agentgate/core';
