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

const transferWithMemoEventAbi = parseAbi([
  'event TransferWithMemo(address indexed from, address indexed to, uint256 value, bytes32 memo)',
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

    const ZERO_MEMO = '0x0000000000000000000000000000000000000000000000000000000000000000';
    const hasMemoRequirement = params.requirement.memo && params.requirement.memo !== ZERO_MEMO;

    // Try TransferWithMemo event first
    let from: Address | undefined;
    let to: Address | undefined;
    let value: bigint | undefined;
    let onChainMemo: Hex | undefined;

    const memoLog = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== params.requirement.tokenAddress.toLowerCase()) return false;
      try {
        const decoded = decodeEventLog({
          abi: transferWithMemoEventAbi,
          data: log.data,
          topics: log.topics,
        });
        return (
          decoded.eventName === 'TransferWithMemo' &&
          (decoded.args as any).to.toLowerCase() === params.requirement.recipientAddress.toLowerCase()
        );
      } catch {
        return false;
      }
    });

    if (memoLog) {
      const decoded = decodeEventLog({
        abi: transferWithMemoEventAbi,
        data: memoLog.data,
        topics: memoLog.topics,
      });
      const args = decoded.args as { from: Address; to: Address; value: bigint; memo: Hex };
      from = args.from;
      to = args.to;
      value = args.value;
      onChainMemo = args.memo;
    } else {
      // Fall back to plain Transfer event
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
      from = args.from;
      to = args.to;
      value = args.value;
    }

    const requiredAmount = BigInt(params.requirement.amountRequired);

    if (value! < requiredAmount) {
      return {
        valid: false,
        error: `Insufficient payment: got ${value}, need ${requiredAmount}`,
        from,
        to,
        amount: value,
        txHash: params.txHash,
        blockNumber: receipt.blockNumber,
      };
    }

    // Verify memo if required
    if (hasMemoRequirement && onChainMemo) {
      if (onChainMemo.toLowerCase() !== params.requirement.memo.toLowerCase()) {
        return {
          valid: false,
          error: `Memo mismatch: expected ${params.requirement.memo}, got ${onChainMemo}`,
          from,
          to,
          amount: value,
          txHash: params.txHash,
          blockNumber: receipt.blockNumber,
        };
      }
    }

    return {
      valid: true,
      from,
      to,
      amount: value,
      txHash: params.txHash,
      blockNumber: receipt.blockNumber,
    };
  } catch (err: any) {
    return { valid: false, error: `Verification failed: ${err.message}` };
  }
}
