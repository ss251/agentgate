import { keccak256, encodePacked, type Address, type Hex, parseUnits } from 'viem';
import { STABLECOINS, type StablecoinSymbol } from './tokens';

/**
 * Create a deterministic payment memo from request details.
 * memo = keccak256(endpoint + bodyHash + nonce + expiry)
 * This ties every on-chain transfer to a specific API call.
 */
export function createPaymentMemo(params: {
  endpoint: string;
  bodyHash: Hex;
  nonce: string;
  expiry: number;
}): Hex {
  return keccak256(
    encodePacked(
      ['string', 'bytes32', 'string', 'uint256'],
      [params.endpoint, params.bodyHash, params.nonce, BigInt(params.expiry)]
    )
  );
}

/**
 * Parse the X-Payment header from an agent's request.
 * Format: "txHash:chainId"
 */
export function parsePaymentHeader(header: string): { txHash: Hex; chainId: number } | null {
  const parts = header.split(':');
  if (parts.length < 2) return null;
  const txHash = parts[0] as Hex;
  const chainId = parseInt(parts[1], 10);
  if (!txHash.startsWith('0x') || isNaN(chainId)) return null;
  return { txHash, chainId };
}

/**
 * Build a 402 payment requirement response body.
 */
export function buildPaymentRequirement(params: {
  recipientAddress: Address;
  token: StablecoinSymbol;
  amount: string; // human-readable, e.g. "0.01"
  endpoint: string;
  nonce: string;
  expiry: number;
  chainId: number;
  description?: string;
}): import('./verify').PaymentRequirement {
  const tokenInfo = STABLECOINS[params.token];
  return {
    recipientAddress: params.recipientAddress,
    tokenAddress: tokenInfo.address,
    tokenSymbol: params.token,
    amountRequired: parseUnits(params.amount, tokenInfo.decimals).toString(),
    amountHuman: params.amount,
    endpoint: params.endpoint,
    nonce: params.nonce,
    expiry: params.expiry,
    chainId: params.chainId,
    memo: createPaymentMemo({
      endpoint: params.endpoint,
      bodyHash: keccak256(encodePacked(['string'], [params.nonce])),
      nonce: params.nonce,
      expiry: params.expiry,
    }),
    description: params.description,
  };
}
