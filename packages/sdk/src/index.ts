import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  type Address,
  type Hex,
  type Chain,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoTestnet, ERC20_ABI, STABLECOINS, type StablecoinSymbol } from '@agentgate/core';

export interface AgentWalletConfig {
  privateKey: Hex;
  chain?: Chain;
  rpcUrl?: string;
}

/**
 * AgentGate SDK — wraps fetch with automatic 402 payment handling.
 */
export class AgentGateClient {
  private account: ReturnType<typeof privateKeyToAccount>;
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
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
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

    console.log(`[AgentGate] 💰 Payment required: ${payment.amountHuman} ${payment.tokenSymbol}`);

    // Send payment on-chain
    const txHash = await this.sendPayment({
      to: payment.recipientAddress,
      tokenAddress: payment.tokenAddress,
      amount: BigInt(payment.amountRequired),
    });

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
  }

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

  async getBalance(token: StablecoinSymbol = 'pathUSD'): Promise<bigint> {
    const publicClient = createPublicClient({
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    return await publicClient.readContract({
      address: STABLECOINS[token].address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [this.account.address],
    }) as bigint;
  }

  async discover(baseUrl: string): Promise<any> {
    const res = await fetch(`${baseUrl}/.well-known/x-agentgate.json`);
    if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
    return res.json();
  }
}

export { tempoTestnet, tempoMainnet } from '@agentgate/core';
