import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import type { Address, Hex, Chain } from 'viem';
import { parseUnits } from 'viem';
import {
  verifyPayment,
  buildPaymentRequirement,
  STABLECOINS,
  type StablecoinSymbol,
  type PaymentRequirement,
  tempoTestnet,
} from '@tempo-agentgate/core';

export interface EndpointPricing {
  amount: string;       // human-readable, e.g. "0.01"
  description?: string;
}

export interface PaywallOptions {
  recipientAddress: Address;
  token?: StablecoinSymbol;
  pricing: Record<string, EndpointPricing>;
  expirySeconds?: number;
  chain?: Chain;
  rpcUrl?: string;
  usedTxHashes?: Set<string>;
  onPayment?: (info: { from: Address; amount: bigint; txHash: Hex; endpoint: string }) => void | Promise<void>;
}

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

  const tokenInfo = STABLECOINS[token];

  return createMiddleware(async (c, next) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const key = `${method} ${path}`;

    const price = pricing[key];
    if (!price) {
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

    // Parse payment header (format: txHash:chainId)
    const colonIdx = paymentHeader.lastIndexOf(':');
    if (colonIdx === -1) {
      return c.json({ error: 'Invalid X-Payment header format. Expected: txHash:chainId' }, 400);
    }
    const txHash = paymentHeader.slice(0, colonIdx) as Hex;
    const paymentChainId = parseInt(paymentHeader.slice(colonIdx + 1), 10);

    if (!txHash.startsWith('0x') || isNaN(paymentChainId)) {
      return c.json({ error: 'Invalid X-Payment header format' }, 400);
    }

    // Replay protection
    if (usedTxHashes.has(txHash)) {
      return c.json({ error: 'Transaction already used for a previous request' }, 409);
    }

    // Build requirement for verification
    const amountRequired = parseUnits(price.amount, tokenInfo.decimals).toString();

    const requirement: PaymentRequirement = {
      recipientAddress,
      tokenAddress: tokenInfo.address,
      tokenSymbol: token,
      amountRequired,
      amountHuman: price.amount,
      endpoint: key,
      nonce: '',
      expiry: Math.floor(Date.now() / 1000) + expirySeconds,
      chainId: chain.id,
      memo: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
    };

    const verification = await verifyPayment({
      txHash,
      requirement,
      chain,
      rpcUrl,
    });

    if (!verification.valid) {
      return c.json({ error: 'Payment verification failed', details: verification.error }, 402);
    }

    // Mark tx as used
    usedTxHashes.add(txHash);

    if (onPayment && verification.from) {
      await onPayment({
        from: verification.from,
        amount: verification.amount!,
        txHash,
        endpoint: key,
      });
    }

    c.set('payment' as any, verification);

    return next();
  });
}

export type { PaymentRequirement, PaymentVerification } from '@tempo-agentgate/core';
