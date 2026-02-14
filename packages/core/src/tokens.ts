import type { Address } from 'viem';

export type StablecoinSymbol = 'pathUSD' | 'AlphaUSD' | 'BetaUSD' | 'ThetaUSD';

export const STABLECOINS: Record<StablecoinSymbol, { address: Address; decimals: number }> = {
  pathUSD:  { address: '0x20c0000000000000000000000000000000000000', decimals: 6 },
  AlphaUSD: { address: '0x20c0000000000000000000000000000000000001', decimals: 6 },
  BetaUSD:  { address: '0x20c0000000000000000000000000000000000002', decimals: 6 },
  ThetaUSD: { address: '0x20c0000000000000000000000000000000000003', decimals: 6 },
};
