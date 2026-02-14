import type { PublicClient, WalletClient } from 'viem';
import {
  type PaymentRequired,
  type AgentRegistration,
  TIP20_ABI,
  TOKENS,
} from '@agentgate/core';

export interface AgentConfig {
  walletClient: WalletClient;
  publicClient: PublicClient;
  defaultToken?: `0x${string}`;
}

/**
 * Creates a fetch wrapper that automatically handles HTTP 402 payments.
 * When a 402 is received, it parses the payment requirement, sends a
 * TIP-20 transfer on Tempo, and retries the request with the tx hash.
 */
export function createPayingFetch(config: AgentConfig): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);

    // Clone body for potential retry
    const bodyClone = init?.body ? init.body : undefined;

    const response = await fetch(request.clone());

    if (response.status !== 402) {
      return response;
    }

    // Parse payment requirement
    const paymentRequired: PaymentRequired = await response.json();
    console.log(`[AgentGate] 💰 Payment required: ${paymentRequired.description}`);
    console.log(`[AgentGate]    Amount: ${paymentRequired.amount} (${paymentRequired.token})`);
    console.log(`[AgentGate]    Recipient: ${paymentRequired.recipient}`);

    // Send TIP-20 transfer
    const account = config.walletClient.account;
    if (!account) throw new Error('Wallet client has no account');

    const token = paymentRequired.token ?? config.defaultToken ?? TOKENS.pathUSD;

    let txHash: `0x${string}`;

    try {
      // Try transferWithMemo first
      txHash = await config.walletClient.writeContract({
        address: token,
        abi: TIP20_ABI,
        functionName: 'transferWithMemo',
        args: [
          paymentRequired.recipient,
          BigInt(paymentRequired.amount),
          paymentRequired.memo,
        ],
        account,
        chain: config.walletClient.chain,
      });
    } catch {
      // Fall back to standard transfer
      txHash = await config.walletClient.writeContract({
        address: token,
        abi: TIP20_ABI,
        functionName: 'transfer',
        args: [paymentRequired.recipient, BigInt(paymentRequired.amount)],
        account,
        chain: config.walletClient.chain,
      });
    }

    console.log(`[AgentGate] ✅ Payment sent: ${txHash}`);

    // Wait for confirmation (instant on Tempo)
    await config.publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`[AgentGate] ⛓️  Confirmed on-chain`);

    // Retry with payment proof
    const retryInit: RequestInit = {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        'X-Payment-Tx': txHash,
      },
    };

    const retryResponse = await fetch(new Request(input, retryInit));
    console.log(`[AgentGate] 📦 Response: ${retryResponse.status}`);

    return retryResponse;
  };
}

/**
 * Higher-level client for interacting with AgentGate-powered services.
 */
export class AgentClient {
  private payingFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.payingFetch = createPayingFetch(config);
  }

  /** Make a request with automatic payment handling */
  async call(url: string, init?: RequestInit): Promise<Response> {
    return this.payingFetch(url, init);
  }

  /** Discover available services at a base URL */
  async discover(baseUrl: string): Promise<AgentRegistration> {
    const url = baseUrl.replace(/\/$/, '') + '/.well-known/agentgate.json';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
    return res.json();
  }
}
