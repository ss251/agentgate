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
          memo: payment.memo as Hex | undefined,
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
   *
   * **Tempo-native optimization**: Unlike Ethereum where nonces are sequential
   * (forcing transactions to be sent one-at-a-time), Tempo uses a 2D nonce system
   * with expiring nonces. This means multiple payment transactions can be submitted
   * concurrently in the same block without nonce conflicts.
   *
   * Flow:
   * 1. Fire all requests in parallel to discover which need payment (402s)
   * 2. Send all payment transactions concurrently (Tempo's 2D nonces allow this)
   * 3. Retry all paid requests in parallel with payment headers
   *
   * Reference: https://docs.tempo.xyz
   */
  async fetchMany(
    requests: Array<{ url: string; init?: RequestInit }>,
  ): Promise<Response[]> {
    // Ensure address is resolved for Privy wallets
    if (this.isPrivy && !this._address) {
      await this.resolveAddress();
    }

    // Phase 1: Fire all requests in parallel to discover payment requirements
    const initialResponses = await Promise.all(
      requests.map(async (r) => {
        try {
          return await globalThis.fetch(r.url, r.init);
        } catch (err) {
          return null;
        }
      })
    );

    // Phase 2: Identify which responses are 402s and extract payment info
    const paymentTasks: Array<{
      index: number;
      payment: any;
      request: { url: string; init?: RequestInit };
    }> = [];

    const results: (Response | null)[] = [...initialResponses];

    for (let i = 0; i < initialResponses.length; i++) {
      const res = initialResponses[i];
      if (res && res.status === 402) {
        try {
          const body = await res.json();
          if (body.payment?.recipientAddress && body.payment?.amountRequired && body.payment?.tokenAddress) {
            paymentTasks.push({ index: i, payment: body.payment, request: requests[i] });
            results[i] = null; // Mark for retry
          }
        } catch {
          // Not a valid 402 response, keep as-is
        }
      }
    }

    if (paymentTasks.length === 0) {
      return results.map((r, i) => r ?? initialResponses[i]!) as Response[];
    }

    // Phase 3: Send all payments in parallel
    // Tempo's expiring 2D nonces allow concurrent transaction submission —
    // each tx gets a unique (queue, nonce) pair that expires after a time window,
    // unlike Ethereum's sequential nonce which forces serial execution.
    const paymentResults = await Promise.all(
      paymentTasks.map(async (task) => {
        try {
          this.emit({
            type: 'payment_required',
            amount: task.payment.amountHuman ?? task.payment.amountRequired,
            token: task.payment.tokenSymbol ?? 'pathUSD',
            endpoint: task.request.url,
          });

          const txHash = await this.sendPayment({
            to: task.payment.recipientAddress,
            tokenAddress: task.payment.tokenAddress,
            amount: BigInt(task.payment.amountRequired),
            memo: task.payment.memo as Hex | undefined,
          });

          this.emit({ type: 'payment_confirmed', txHash });
          return { index: task.index, txHash, request: task.request };
        } catch (err: any) {
          this.emit({ type: 'error', error: err.message });
          throw err;
        }
      })
    );

    // Phase 4: Retry all paid requests in parallel with payment headers
    const retryResults = await Promise.all(
      paymentResults.map(async ({ index, txHash, request }) => {
        const retryHeaders = new Headers(request.init?.headers);
        retryHeaders.set('X-Payment', `${txHash}:${this.chain.id}`);
        const response = await globalThis.fetch(request.url, {
          ...request.init,
          headers: retryHeaders,
        });
        return { index, response };
      })
    );

    // Merge results
    for (const { index, response } of retryResults) {
      results[index] = response;
    }

    return results as Response[];
  }

  /**
   * Fetch multiple URLs using a single batched Tempo transaction.
   *
   * **Tempo-native feature**: Tempo supports batch transactions that atomically
   * execute multiple calls in a single transaction. This means an agent can pay
   * for multiple API calls with one on-chain transaction, reducing latency and
   * ensuring atomicity (all payments succeed or all fail).
   *
   * Flow:
   * 1. Discover all payment requirements (fire requests, collect 402s)
   * 2. Batch all ERC-20 transfers into a single transaction using multicall
   * 3. Retry all requests with the single batch tx hash
   *
   * Reference: https://docs.tempo.xyz/guide/use-accounts/batch-transactions
   *
   * Note: Full batch transaction support requires Tempo's native batch call type.
   * This implementation uses sequential transfers as a fallback, but documents
   * how it would work with Tempo's native batching for atomic multi-service payments.
   */
  async fetchBatch(
    requests: Array<{ url: string; init?: RequestInit }>,
  ): Promise<Response[]> {
    // Ensure address is resolved for Privy wallets
    if (this.isPrivy && !this._address) {
      await this.resolveAddress();
    }

    // Phase 1: Discover all payment requirements
    const initialResponses = await Promise.all(
      requests.map(async (r) => {
        try {
          return await globalThis.fetch(r.url, r.init);
        } catch (err) {
          return null;
        }
      })
    );

    const paymentTasks: Array<{
      index: number;
      payment: any;
      request: { url: string; init?: RequestInit };
    }> = [];

    const results: (Response | null)[] = [...initialResponses];

    for (let i = 0; i < initialResponses.length; i++) {
      const res = initialResponses[i];
      if (res && res.status === 402) {
        try {
          const body = await res.json();
          if (body.payment?.recipientAddress && body.payment?.amountRequired && body.payment?.tokenAddress) {
            paymentTasks.push({ index: i, payment: body.payment, request: requests[i] });
            results[i] = null;
          }
        } catch {}
      }
    }

    if (paymentTasks.length === 0) {
      return results.map((r, i) => r ?? initialResponses[i]!) as Response[];
    }

    // Phase 2: Batch payments using Tempo's native batch transaction
    // Tempo supports atomic batch transactions via the `calls` vector in TempoTransaction.
    // All ERC-20 transfers are bundled into a single transaction — one signature, one tx hash.
    // All calls succeed or all fail (atomic execution).

    console.log(`[AgentGate] 📦 Batch: ${paymentTasks.length} payments in single Tempo batch tx`);

    for (const task of paymentTasks) {
      this.emit({
        type: 'payment_required',
        amount: task.payment.amountHuman ?? task.payment.amountRequired,
        token: task.payment.tokenSymbol ?? 'pathUSD',
        endpoint: task.request.url,
      });
    }

    // Build batch calls — one ERC-20 transfer per payment
    const batchCalls = paymentTasks.map((task) => ({
      to: task.payment.tokenAddress as Address,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [task.payment.recipientAddress as Address, BigInt(task.payment.amountRequired)],
      }),
    }));

    let batchTxHash: Hex;

    if (this.privyConfig) {
      // Privy doesn't support batch calls — fall back to parallel individual transfers
      console.log(`[AgentGate] ⚠️ Privy wallet: falling back to parallel individual transfers`);
      const paymentResults = await Promise.all(
        paymentTasks.map(async (task) => {
          const txHash = await this.sendPayment({
            to: task.payment.recipientAddress,
            tokenAddress: task.payment.tokenAddress,
            amount: BigInt(task.payment.amountRequired),
            memo: task.payment.memo as Hex | undefined,
          });
          this.emit({ type: 'payment_confirmed', txHash });
          return { index: task.index, txHash, request: task.request };
        })
      );

      // Retry with individual tx hashes
      const retryResults = await Promise.all(
        paymentResults.map(async ({ index, txHash, request }) => {
          const retryHeaders = new Headers(request.init?.headers);
          retryHeaders.set('X-Payment', `${txHash}:${this.chain.id}`);
          const response = await globalThis.fetch(request.url, {
            ...request.init,
            headers: retryHeaders,
          });
          return { index, response };
        })
      );

      for (const { index, response } of retryResults) {
        results[index] = response;
      }

      return results as Response[];
    }

    // Native Tempo batch transaction — single tx for all payments
    const walletClient = createWalletClient({
      account: this.account!,
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    // Tempo's sendTransaction accepts a `calls` array for batch execution
    // Each call is atomically executed — all succeed or all revert
    batchTxHash = await walletClient.sendTransaction({
      calls: batchCalls,
    } as any);

    const publicClient = createPublicClient({
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    await publicClient.waitForTransactionReceipt({ hash: batchTxHash, confirmations: 1 });
    this.emit({ type: 'payment_confirmed', txHash: batchTxHash });
    console.log(`[AgentGate] ✅ Batch payment sent: ${batchTxHash}`);

    // Phase 3: Retry all paid requests with the single batch tx hash
    const retryResults = await Promise.all(
      paymentTasks.map(async (task) => {
        const retryHeaders = new Headers(task.request.init?.headers);
        retryHeaders.set('X-Payment', `${batchTxHash}:${this.chain.id}`);
        const response = await globalThis.fetch(task.request.url, {
          ...task.request.init,
          headers: retryHeaders,
        });
        return { index: task.index, response };
      })
    );

    for (const { index, response } of retryResults) {
      results[index] = response;
    }

    return results as Response[];
  }

  /**
   * Send an ERC-20 transfer on-chain.
   * Uses Privy API when configured, otherwise uses viem wallet client.
   */
  async sendPayment(params: {
    to: Address;
    tokenAddress: Address;
    amount: bigint;
    memo?: Hex;
  }): Promise<Hex> {
    const data = params.memo
      ? encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transferWithMemo',
          args: [params.to, params.amount, params.memo],
        })
      : encodeFunctionData({
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
