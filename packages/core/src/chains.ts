import { defineChain } from 'viem';

export const tempoTestnet = defineChain({
  id: 42431,
  name: 'Tempo Testnet (Moderato)',
  nativeCurrency: { name: 'pathUSD', symbol: 'pathUSD', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.moderato.tempo.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Tempo Explorer', url: 'https://explorer.moderato.tempo.xyz' },
  },
  testnet: true,
});

export const tempoMainnet = defineChain({
  id: 42420,
  name: 'Tempo',
  nativeCurrency: { name: 'pathUSD', symbol: 'pathUSD', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.tempo.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Tempo Explorer', url: 'https://explore.tempo.xyz' },
  },
});
