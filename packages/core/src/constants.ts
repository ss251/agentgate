import { defineChain } from 'viem';

/** Tempo Moderato Testnet chain definition */
export const tempoTestnet = defineChain({
  id: 42431,
  name: 'Tempo Testnet (Moderato)',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.moderato.tempo.xyz'], webSocket: ['wss://rpc.moderato.tempo.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Tempo Explorer', url: 'https://explore.tempo.xyz' },
  },
});

/** Well-known TIP-20 token addresses on Tempo Moderato */
export const TOKENS = {
  pathUSD: '0x20c0000000000000000000000000000000000000' as `0x${string}`,
} as const;

/** System contract addresses */
export const CONTRACTS = {
  tip20Factory: '0x20fc000000000000000000000000000000000000' as `0x${string}`,
  feeManager: '0xfeec000000000000000000000000000000000000' as `0x${string}`,
  stablecoinDex: '0xdec0000000000000000000000000000000000000' as `0x${string}`,
  tip403Registry: '0x403c000000000000000000000000000000000000' as `0x${string}`,
} as const;

/** Default token decimals (TIP-20 stablecoins use 6 decimals) */
export const DEFAULT_DECIMALS = 6;

/** Default RPC URL */
export const DEFAULT_RPC_URL = 'https://rpc.moderato.tempo.xyz';

/** Standard ERC-20 / TIP-20 ABI (subset needed for payments) */
export const TIP20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transferWithMemo',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'memo', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TransferWithMemo',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
      { name: 'memo', type: 'bytes32', indexed: false },
    ],
  },
] as const;

/** Transfer event signature topic */
export const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as `0x${string}`;
