#!/usr/bin/env bun
/**
 * Fund a Privy wallet by transferring pathUSD from the agent wallet
 */
import { createWalletClient, createPublicClient, http, encodeFunctionData, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoTestnet, ERC20_ABI, STABLECOINS } from '../packages/core/src/index';

const AGENT_PK = process.env.AGENT_PRIVATE_KEY as `0x${string}`;
const TO = (process.argv[2] || '0x1e5984Bb0aF8Df96A1FBD5948396B9Dc8a8F33dd') as `0x${string}`;
const AMOUNT = process.argv[3] || '100'; // pathUSD

const account = privateKeyToAccount(AGENT_PK);
const walletClient = createWalletClient({ account, chain: tempoTestnet, transport: http() });
const publicClient = createPublicClient({ chain: tempoTestnet, transport: http() });

console.log(`Sending ${AMOUNT} pathUSD from ${account.address} to ${TO}...`);

const hash = await walletClient.sendTransaction({
  to: STABLECOINS.pathUSD.address,
  data: encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [TO, parseUnits(AMOUNT, 6)],
  }),
});

console.log(`Tx: ${hash}`);
await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });

const balance = await publicClient.readContract({
  address: STABLECOINS.pathUSD.address,
  abi: ERC20_ABI,
  functionName: 'balanceOf',
  args: [TO],
}) as bigint;

console.log(`✅ Done! ${TO} now has ${formatUnits(balance, 6)} pathUSD`);
