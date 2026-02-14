import { type Address, type Hex, type Chain } from 'viem';
export interface PaymentRequirement {
    recipientAddress: Address;
    tokenAddress: Address;
    tokenSymbol: string;
    amountRequired: string;
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
/**
 * Verify an on-chain TIP-20 (ERC-20) transfer on Tempo.
 * Checks: tx exists, correct token, correct recipient, sufficient amount.
 */
export declare function verifyPayment(params: {
    txHash: Hex;
    requirement: PaymentRequirement;
    chain?: Chain;
    rpcUrl?: string;
}): Promise<PaymentVerification>;
//# sourceMappingURL=verify.d.ts.map