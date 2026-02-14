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
import { tempoTestnet, ERC20_ABI, STABLECOINS, type StablecoinSymbol } from '@tempo-agentgate/core';

// ─── Config Types ────────────────────────────────────────────────

export interface AgentWalletConfig {
  privateKey: Hex;
  feePayerPrivateKey?: Hex;
  chain?: Chain;
  rpcUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  onPaymentEvent?: (event: PaymentEvent) => void;
}

export interface PrivyWalletConfig {
  privyAppId: string;
  privyAppSecret: string;
  walletId: string;
  chain?: Chain;
  rpcUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  onPaymentEvent?: (event: PaymentEvent) => void;
}

export type AgentGateConfig = AgentWalletConfig | PrivyWalletConfig;

function isPrivyConfig(config: AgentGateConfig): config is PrivyWalletConfig {
  return 'privyAppId' in config && 'privyAppSecret' in config && 'walletId' in config;
}

export type PaymentEvent =
  | { type: 'payment_required'; amount: string; token: string; endpoint: string }
  | { type: 'payment_sending'; txData: { to: Address; amount: bigint } }
  | { type: 'payment_confirmed'; txHash: Hex }
  | { type: 'retrying'; attempt: number; reason: string }
  | { type: 'error'; error: string };

// ─── Privy API Helper ────────────────────────────────────────────

async function privySendTransaction(config: PrivyWalletConfig, params: {
  to: Address;
  data: Hex;
  chainId: number;
}): Promise<Hex> {
  const basicAuth = Buffer.from(`${config.privyAppId}:${config.privyAppSecret}`).toString('base64');

  const res = await fetch(`https://api.privy.io/v1/wallets/${config.walletId}/rpc`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'privy-app-id': config.privyAppId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      method: 'eth_sendTransaction',
      caip2: `eip155:${params.chainId}`,
      params: {
        transaction: {
          to: params.to,
          data: params.data,
        },
      },
      sponsor: true, // Fee sponsorship — Privy handles gas
    }),
  });

  // If sponsorship not enabled, retry without it
  if (!res.ok) {
    const errText = await res.text();
    if (errText.includes('Gas sponsorship is not enabled')) {
      const retryRes = await fetch(`https://api.privy.io/v1/wallets/${config.walletId}/rpc`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'privy-app-id': config.privyAppId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          method: 'eth_sendTransaction',
          caip2: `eip155:${params.chainId}`,
          params: {
            transaction: {
              to: params.to,
              data: params.data,
            },
          },
        }),
      });
      if (!retryRes.ok) {
        const retryErr = await retryRes.text();
        throw new Error(`Privy RPC failed (${retryRes.status}): ${retryErr}`);
      }
      const result = await retryRes.json() as any;
      return result.data?.hash ?? result.hash ?? result.result;
    }
    throw new Error(`Privy RPC failed (${res.status}): ${errText}`);
  }

  const result = await res.json() as any;
  return result.data?.hash ?? result.hash ?? result.result;
}

async function privyGetAddress(config: PrivyWalletConfig): Promise<Address> {
  const basicAuth = Buffer.from(`${config.privyAppId}:${config.privyAppSecret}`).toString('base64');

  const res = await fetch(`https://api.privy.io/v1/wallets/${config.walletId}`, {
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'privy-app-id': config.privyAppId,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Privy wallet fetch failed (${res.status}): ${err}`);
  }

  const data = await res.json() as any;
  return data.address as Address;
}

export async function createPrivyWallet(appId: string, appSecret: string): Promise<{ walletId: string; address: string }> {
  const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString('base64');

  const res = await fetch('https://api.privy.io/v1/wallets', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'privy-app-id': appId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chain_type: 'ethereum' }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Privy wallet creation failed (${res.status}): ${err}`);
  }

  const data = await res.json() as any;
  return { walletId: data.id, address: data.address };
}

// ─── AgentGateClient ─────────────────────────────────────────────

/**
 * AgentGate SDK — wraps fetch with automatic 402 payment handling.
 *
 * Supports two wallet modes:
 * 1. Raw private key (viem) — direct on-chain signing
 * 2. Privy server wallet — delegated signing via Privy API with fee sponsorship
 *
 * Features:
 * - Auto-detect 402 Payment Required and pay on-chain
 * - Retry with exponential backoff for transient failures
 * - Optional balance pre-check (fail fast if insufficient funds)
 * - Payment lifecycle callbacks
 * - Batch fetching via fetchMany()
 * - Fee sponsorship (automatic with Privy, optional with raw keys)
 */
export class AgentGateClient {
  private account: ReturnType<typeof privateKeyToAccount> | null = null;
  private privyConfig: PrivyWalletConfig | null = null;
  private chain: Chain;
  private rpcUrl?: string;
  private maxRetries: number;
  private timeoutMs: number;
  private onPaymentEvent?: (event: PaymentEvent) => void;
  private _address: Address | null = null;

  constructor(config: AgentGateConfig) {
    if (isPrivyConfig(config)) {
      this.privyConfig = config;
    } else {
      this.account = privateKeyToAccount(config.privateKey);
      this._address = this.account.address;
    }
    this.chain = config.chain ?? tempoTestnet;
    this.rpcUrl = config.rpcUrl;
    this.maxRetries = config.maxRetries ?? 3;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.onPaymentEvent = config.onPaymentEvent;
  }

  get address(): Address {
    if (this._address) return this._address;
    throw new Error('Address not yet resolved. Call resolveAddress() first for Privy wallets.');
  }

  /**
   * Resolve the wallet address. Required for Privy wallets before first use.
   * For raw key wallets, this is a no-op.
   */
  async resolveAddress(): Promise<Address> {
    if (this._address) return this._address;
    if (this.privyConfig) {
      this._address = await privyGetAddress(this.privyConfig);
      return this._address;
    }
    throw new Error('No wallet configured');
  }

  private get isPrivy(): boolean {
    return this.privyConfig !== null;
  }

  private emit(event: PaymentEvent) {
    this.onPaymentEvent?.(event);
  }

  /**
   * Fetch with automatic 402 → pay → retry.
   * Includes retry logic with exponential backoff for transient failures.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    // Ensure address is resolved for Privy wallets
    if (this.isPrivy && !this._address) {
      await this.resolveAddress();
    }

    const deadline = Date.now() + this.timeoutMs;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (Date.now() > deadline) {
        throw new Error(`AgentGate fetch timed out after ${this.timeoutMs}ms`);
      }

      try {
        const response = await globalThis.fetch(url, init);

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

        const retryResponse = await globalThis.fetch(url, {
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
   * Uses Privy API when configured, otherwise uses viem wallet client.
   */
  async sendPayment(params: {
    to: Address;
    tokenAddress: Address;
    amount: bigint;
  }): Promise<Hex> {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [params.to, params.amount],
    });

    if (this.privyConfig) {
      // Privy path — delegated signing with fee sponsorship
      const txHash = await privySendTransaction(this.privyConfig, {
        to: params.tokenAddress,
        data,
        chainId: this.chain.id,
      });

      // Wait for confirmation via public client
      const publicClient = createPublicClient({
        chain: this.chain,
        transport: http(this.rpcUrl),
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
      return txHash;
    }

    // Raw key path — direct viem signing
    const walletClient = createWalletClient({
      account: this.account!,
      chain: this.chain,
      transport: http(this.rpcUrl),
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
    const addr = this._address ?? (await this.resolveAddress());

    const publicClient = createPublicClient({
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    return (await publicClient.readContract({
      address: STABLECOINS[token].address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [addr],
    })) as bigint;
  }

  /**
   * Discover services at a gateway URL.
   */
  async discover(baseUrl: string): Promise<any> {
    const res = await globalThis.fetch(`${baseUrl}/.well-known/x-agentgate.json`);
    if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
    return res.json();
  }
}

export { tempoTestnet, tempoMainnet } from '@tempo-agentgate/core';
