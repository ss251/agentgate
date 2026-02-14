import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  formatUnits,
  type Address,
  type Hex,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoTestnet, ERC20_ABI, STABLECOINS, type StablecoinSymbol } from '@agentgate/core';

export interface AgentWalletConfig {
  privateKey: Hex;
  chain?: Chain;
  rpcUrl?: string;
  /** Max retries for transient failures (default: 3) */
  maxRetries?: number;
  /** Overall timeout for fetch cycle in ms (default: 60000) */
  timeoutMs?: number;
  /** Callback for payment lifecycle events */
  onPaymentEvent?: (event: PaymentEvent) => void;
}

export type PaymentEvent =
  | { type: 'payment_required'; amount: string; token: string; endpoint: string }
  | { type: 'payment_sending'; txData: { to: Address; amount: bigint } }
  | { type: 'payment_confirmed'; txHash: Hex }
  | { type: 'retrying'; attempt: number; reason: string }
  | { type: 'error'; error: string };

/**
 * AgentGate SDK — wraps fetch with automatic 402 payment handling.
 *
 * Features:
 * - Auto-detect 402 Payment Required and pay on-chain
 * - Retry with exponential backoff for transient failures
 * - Optional balance pre-check (fail fast if insufficient funds)
 * - Payment lifecycle callbacks
 * - Batch fetching via fetchMany()
 */
export class AgentGateClient {
  private account: ReturnType<typeof privateKeyToAccount>;
  private chain: Chain;
  private rpcUrl?: string;
  private maxRetries: number;
  private timeoutMs: number;
  private onPaymentEvent?: (event: PaymentEvent) => void;

  constructor(config: AgentWalletConfig) {
    this.account = privateKeyToAccount(config.privateKey);
    this.chain = config.chain ?? tempoTestnet;
    this.rpcUrl = config.rpcUrl;
    this.maxRetries = config.maxRetries ?? 3;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.onPaymentEvent = config.onPaymentEvent;
  }

  get address(): Address {
    return this.account.address;
  }

  private emit(event: PaymentEvent) {
    this.onPaymentEvent?.(event);
  }

  /**
   * Fetch with automatic 402 → pay → retry.
   * Includes retry logic with exponential backoff for transient failures.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const deadline = Date.now() + this.timeoutMs;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (Date.now() > deadline) {
        throw new Error(`AgentGate fetch timed out after ${this.timeoutMs}ms`);
      }

      try {
        const response = await fetch(url, init);

        if (response.status !== 402) {
          return response;
        }

        // Parse 402 response
        const body = await response.json();
        const payment = body.payment;

        if (!payment?.recipientAddress || !payment?.amountRequired || !payment?.tokenAddress) {
          throw new Error('Invalid 402 response: missing payment requirements');
        }

        this.emit({
          type: 'payment_required',
          amount: payment.amountHuman ?? payment.amountRequired,
          token: payment.tokenSymbol ?? 'pathUSD',
          endpoint: url,
        });

        console.log(`[AgentGate] 💰 Payment required: ${payment.amountHuman} ${payment.tokenSymbol}`);

        // Optional: balance pre-check
        const requiredAmount = BigInt(payment.amountRequired);
        try {
          const balance = await this.getBalance(payment.tokenSymbol as StablecoinSymbol);
          if (balance < requiredAmount) {
            const err = `Insufficient balance: have ${formatUnits(balance, 6)} ${payment.tokenSymbol}, need ${payment.amountHuman}`;
            this.emit({ type: 'error', error: err });
            throw new Error(err);
          }
        } catch (e: any) {
          // If balance check fails, proceed anyway (non-critical)
          if (e.message.includes('Insufficient balance')) throw e;
        }

        // Send payment on-chain
        this.emit({
          type: 'payment_sending',
          txData: { to: payment.recipientAddress, amount: requiredAmount },
        });

        const txHash = await this.sendPayment({
          to: payment.recipientAddress,
          tokenAddress: payment.tokenAddress,
          amount: requiredAmount,
        });

        this.emit({ type: 'payment_confirmed', txHash });
        console.log(`[AgentGate] ✅ Payment sent: ${txHash}`);

        // Retry with payment header
        const retryHeaders = new Headers(init?.headers);
        retryHeaders.set('X-Payment', `${txHash}:${this.chain.id}`);

        const retryResponse = await fetch(url, {
          ...init,
          headers: retryHeaders,
        });

        console.log(`[AgentGate] 📦 Response: ${retryResponse.status}`);
        return retryResponse;
      } catch (err: any) {
        // Don't retry on non-transient errors
        if (
          err.message.includes('Insufficient balance') ||
          err.message.includes('Invalid 402') ||
          attempt >= this.maxRetries
        ) {
          throw err;
        }

        const delay = Math.min(1000 * 2 ** attempt, 10000);
        this.emit({ type: 'retrying', attempt: attempt + 1, reason: err.message });
        console.log(`[AgentGate] ⏳ Retry ${attempt + 1}/${this.maxRetries} in ${delay}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error('AgentGate fetch failed after all retries');
  }

  /**
   * Fetch multiple URLs in parallel with automatic payment handling.
   */
  async fetchMany(
    requests: Array<{ url: string; init?: RequestInit }>,
  ): Promise<Response[]> {
    return Promise.all(requests.map((r) => this.fetch(r.url, r.init)));
  }

  /**
   * Send an ERC-20 transfer on-chain.
   */
  async sendPayment(params: {
    to: Address;
    tokenAddress: Address;
    amount: bigint;
  }): Promise<Hex> {
    const walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [params.to, params.amount],
    });

    const hash = await walletClient.sendTransaction({
      to: params.tokenAddress,
      data,
    });

    const publicClient = createPublicClient({
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    return hash;
  }

  /**
   * Check token balance for this agent's wallet.
   */
  async getBalance(token: StablecoinSymbol = 'pathUSD'): Promise<bigint> {
    const publicClient = createPublicClient({
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    return (await publicClient.readContract({
      address: STABLECOINS[token].address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [this.account.address],
    })) as bigint;
  }

  /**
   * Discover services at a gateway URL.
   */
  async discover(baseUrl: string): Promise<any> {
    const res = await fetch(`${baseUrl}/.well-known/x-agentgate.json`);
    if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
    return res.json();
  }
}

export { tempoTestnet, tempoMainnet } from '@agentgate/core';
