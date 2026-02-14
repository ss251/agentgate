import type { Address } from 'viem';
export type StablecoinSymbol = 'pathUSD' | 'AlphaUSD' | 'BetaUSD' | 'ThetaUSD';
export declare const STABLECOINS: Record<StablecoinSymbol, {
    address: Address;
    decimals: number;
}>;
//# sourceMappingURL=tokens.d.ts.map