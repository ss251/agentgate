import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  type Chain,
  decodeEventLog,
  parseAbi,
} from 'viem';
import { tempoTestnet } from './chains';
import { ERC20_ABI } from './abi';

export interface PaymentRequirement {
  recipientAddress: Address;
  tokenAddress: Address;
  tokenSymbol: string;
  amountRequired: string; // raw units
  amountHuman: string;
  endpoint: string;
  nonce: string;
  expiry: number;
  chainId: number;
  memo: Hex;
  description?: string;
}

export interface PaymentVerification {
  valid: boolean;
  error?: string;
  from?: Address;
  to?: Address;
  amount?: bigint;
  txHash?: Hex;
  blockNumber?: bigint;
}

const transferEventAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/**
 * Verify an on-chain TIP-20 (ERC-20) transfer on Tempo.
 * Checks: tx exists, correct token, correct recipient, sufficient amount.
 */
export async function verifyPayment(params: {
  txHash: Hex;
  requirement: PaymentRequirement;
  chain?: Chain;
  rpcUrl?: string;
}): Promise<PaymentVerification> {
  const chain = params.chain ?? tempoTestnet;
  const client = createPublicClient({
    chain,
    transport: http(params.rpcUrl),
  });

  try {
    // Check expiry
    if (Date.now() > params.requirement.expiry * 1000) {
      return { valid: false, error: 'Payment requirement expired' };
    }

    const receipt = await client.getTransactionReceipt({ hash: params.txHash });

    if (receipt.status !== 'success') {
      return { valid: false, error: 'Transaction failed on-chain', txHash: params.txHash };
    }

    // Find Transfer event to the recipient from the correct token contract
    const transferLog = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== params.requirement.tokenAddress.toLowerCase()) return false;
      try {
        const decoded = decodeEventLog({
          abi: transferEventAbi,
          data: log.data,
          topics: log.topics,
        });
        return (
          decoded.eventName === 'Transfer' &&
          (decoded.args as any).to.toLowerCase() === params.requirement.recipientAddress.toLowerCase()
        );
      } catch {
        return false;
      }
    });

    if (!transferLog) {
      return {
        valid: false,
        error: 'No matching Transfer event found',
        txHash: params.txHash,
        blockNumber: receipt.blockNumber,
      };
    }

    const decoded = decodeEventLog({
      abi: transferEventAbi,
      data: transferLog.data,
      topics: transferLog.topics,
    });

    const args = decoded.args as { from: Address; to: Address; value: bigint };
    const requiredAmount = BigInt(params.requirement.amountRequired);

    if (args.value < requiredAmount) {
      return {
        valid: false,
        error: `Insufficient payment: got ${args.value}, need ${requiredAmount}`,
        from: args.from,
        to: args.to,
        amount: args.value,
        txHash: params.txHash,
        blockNumber: receipt.blockNumber,
      };
    }

    return {
      valid: true,
      from: args.from,
      to: args.to,
      amount: args.value,
      txHash: params.txHash,
      blockNumber: receipt.blockNumber,
    };
  } catch (err: any) {
    return { valid: false, error: `Verification failed: ${err.message}` };
  }
}
