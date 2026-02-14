import {
  createWalletClient,
  createPublicClient,
  http,
  type Address,
  type Hex,
  type Chain,
  type Account,
  encodeFunctionData,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoTestnet, ERC20_ABI, STABLECOINS, type StablecoinSymbol } from '@agentgate/core';

export interface AgentWalletConfig {
  /** Agent's private key (for hackathon; use Privy server wallets in production) */
  privateKey: Hex;
  /** Chain (default: Tempo testnet) */
  chain?: Chain;
  /** Custom RPC URL */
  rpcUrl?: string;
}

export interface PaymentResponse {
  payment: {
    recipientAddress: Address;
    tokenAddress: Address;
    tokenSymbol: string;
    amountRequired: string;
    amountHuman: string;
    chainId: number;
    [key: string]: any;
  };
}

/**
 * AgentGate SDK — wraps fetch with automatic 402 payment handling.
 * 
 * Usage:
 *   const agent = new AgentGateClient({ privateKey: '0x...' });
 *   const result = await agent.fetch('https://api.example.com/chat', {
 *     method: 'POST',
 *     body: JSON.stringify({ prompt: 'Hello' }),
 *   });
 */
export class AgentGateClient {
  private account: Account;
  private chain: Chain;
  private rpcUrl?: string;

  constructor(config: AgentWalletConfig) {
    this.account = privateKeyToAccount(config.privateKey);
    this.chain = config.chain ?? tempoTestnet;
    this.rpcUrl = config.rpcUrl;
  }

  get address(): Address {
    return this.account.address;
  }

  /**
   * Fetch with automatic 402 → pay → retry.
   * If the server returns 402, the SDK:
   *   1. Parses payment requirements
   *   2. Sends TIP-20 transfer on-chain
   *   3. Retries with X-Payment header
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    // First attempt
    const response = await fetch(url, init);

    if (response.status !== 402) {
      return response;
    }

    // Parse 402 response
    const body: PaymentResponse = await response.json();
    const { payment } = body;

    if (!payment?.recipientAddress || !payment?.amountRequired || !payment?.tokenAddress) {
      throw new Error('Invalid 402 response: missing payment requirements');
    }

    // Send payment on-chain
    const txHash = await this.sendPayment({
      to: payment.recipientAddress,
      tokenAddress: payment.tokenAddress,
      amount: BigInt(payment.amountRequired),
    });

    // Retry with payment header
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('X-Payment', `${txHash}:${this.chain.id}`);

    return fetch(url, {
      ...init,
      headers: retryHeaders,
    });
  }

  /**
   * Send a TIP-20 (ERC-20) transfer on Tempo.
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

    // Wait for confirmation (Tempo has instant finality)
    const publicClient = createPublicClient({
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });

    return hash;
  }

  /**
   * Check balance of a stablecoin.
   */
  async getBalance(token: StablecoinSymbol = 'pathUSD'): Promise<bigint> {
    const publicClient = createPublicClient({
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    const balance = await publicClient.readContract({
      address: STABLECOINS[token].address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [this.account.address],
    });

    return balance as bigint;
  }

  /**
   * Discover AgentGate-enabled endpoints from a host.
   */
  async discover(baseUrl: string): Promise<any> {
    const res = await fetch(`${baseUrl}/.well-known/x-agentgate.json`);
    if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
    return res.json();
  }
}

export { tempoTestnet, tempoMainnet } from '@agentgate/core';
