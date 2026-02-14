import { type Address, type Hex } from 'viem';
import { type StablecoinSymbol } from './tokens';
/**
 * Create a deterministic payment memo from request details.
 * memo = keccak256(endpoint + bodyHash + nonce + expiry)
 * This ties every on-chain transfer to a specific API call.
 */
export declare function createPaymentMemo(params: {
    endpoint: string;
    bodyHash: Hex;
    nonce: string;
    expiry: number;
}): Hex;
/**
 * Parse the X-Payment header from an agent's request.
 * Format: "txHash:chainId"
 */
export declare function parsePaymentHeader(header: string): {
    txHash: Hex;
    chainId: number;
} | null;
/**
 * Build a 402 payment requirement response body.
 */
export declare function buildPaymentRequirement(params: {
    recipientAddress: Address;
    token: StablecoinSymbol;
    amount: string;
    endpoint: string;
    nonce: string;
    expiry: number;
    chainId: number;
    description?: string;
}): import('./verify').PaymentRequirement;
//# sourceMappingURL=utils.d.ts.map