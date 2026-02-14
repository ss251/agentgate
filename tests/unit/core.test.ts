import { describe, test, expect } from 'bun:test';
import { keccak256, encodePacked } from 'viem';
import {
  createPaymentMemo,
  parsePaymentHeader,
  buildPaymentRequirement,
  STABLECOINS,
  tempoTestnet,
} from '../../packages/core/src/index';

describe('createPaymentMemo', () => {
  test('produces deterministic 32-byte hex', () => {
    const memo = createPaymentMemo({
      endpoint: 'POST /api/execute',
      bodyHash: keccak256(encodePacked(['string'], ['test-nonce'])),
      nonce: 'test-nonce',
      expiry: 1700000000,
    });
    expect(memo).toMatch(/^0x[a-f0-9]{64}$/);
  });

  test('same inputs produce same memo', () => {
    const params = {
      endpoint: 'POST /api/execute',
      bodyHash: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
      nonce: 'nonce-1',
      expiry: 1700000000,
    };
    const memo1 = createPaymentMemo(params);
    const memo2 = createPaymentMemo(params);
    expect(memo1).toBe(memo2);
  });

  test('different endpoints produce different memos', () => {
    const base = {
      bodyHash: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
      nonce: 'nonce-1',
      expiry: 1700000000,
    };
    const memo1 = createPaymentMemo({ ...base, endpoint: 'POST /api/execute' });
    const memo2 = createPaymentMemo({ ...base, endpoint: 'POST /api/scrape' });
    expect(memo1).not.toBe(memo2);
  });

  test('different expiry produces different memo', () => {
    const base = {
      endpoint: 'POST /api/execute',
      bodyHash: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
      nonce: 'nonce-1',
    };
    const memo1 = createPaymentMemo({ ...base, expiry: 1700000000 });
    const memo2 = createPaymentMemo({ ...base, expiry: 1700000001 });
    expect(memo1).not.toBe(memo2);
  });
});

describe('parsePaymentHeader', () => {
  test('parses valid header', () => {
    const result = parsePaymentHeader('0xabc123:42431');
    expect(result).toEqual({ txHash: '0xabc123', chainId: 42431 });
  });

  test('parses full tx hash with colons in chain id', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const result = parsePaymentHeader(`${txHash}:42431`);
    expect(result).toEqual({ txHash, chainId: 42431 });
  });

  test('returns null for missing colon', () => {
    expect(parsePaymentHeader('0xabc123')).toBeNull();
  });

  test('returns null for missing 0x prefix', () => {
    expect(parsePaymentHeader('abc123:42431')).toBeNull();
  });

  test('returns null for non-numeric chain ID', () => {
    expect(parsePaymentHeader('0xabc:notanumber')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parsePaymentHeader('')).toBeNull();
  });
});

describe('buildPaymentRequirement', () => {
  test('builds requirement with correct fields', () => {
    const req = buildPaymentRequirement({
      recipientAddress: '0x00DfEe79B7fd7aEF0312E06da8E1d60a5957F9Cf',
      token: 'pathUSD',
      amount: '0.01',
      endpoint: 'POST /api/execute',
      nonce: 'test-nonce',
      expiry: 1700000000,
      chainId: 42431,
      description: 'Code Execution',
    });

    expect(req.recipientAddress).toBe('0x00DfEe79B7fd7aEF0312E06da8E1d60a5957F9Cf');
    expect(req.tokenAddress).toBe(STABLECOINS.pathUSD.address);
    expect(req.tokenSymbol).toBe('pathUSD');
    expect(req.amountRequired).toBe('10000'); // 0.01 * 10^6
    expect(req.amountHuman).toBe('0.01');
    expect(req.chainId).toBe(42431);
    expect(req.memo).toMatch(/^0x[a-f0-9]{64}$/);
    expect(req.description).toBe('Code Execution');
  });

  test('handles different token amounts correctly', () => {
    const req = buildPaymentRequirement({
      recipientAddress: '0x00DfEe79B7fd7aEF0312E06da8E1d60a5957F9Cf',
      token: 'pathUSD',
      amount: '0.005',
      endpoint: 'POST /api/scrape',
      nonce: 'test',
      expiry: 1700000000,
      chainId: 42431,
    });
    expect(req.amountRequired).toBe('5000'); // 0.005 * 10^6
  });

  test('handles large amounts', () => {
    const req = buildPaymentRequirement({
      recipientAddress: '0x00DfEe79B7fd7aEF0312E06da8E1d60a5957F9Cf',
      token: 'pathUSD',
      amount: '1000.00',
      endpoint: 'POST /api/premium',
      nonce: 'test',
      expiry: 1700000000,
      chainId: 42431,
    });
    expect(req.amountRequired).toBe('1000000000'); // 1000 * 10^6
  });

  test('uses correct token address for different tokens', () => {
    const req = buildPaymentRequirement({
      recipientAddress: '0x00DfEe79B7fd7aEF0312E06da8E1d60a5957F9Cf',
      token: 'AlphaUSD',
      amount: '1.00',
      endpoint: 'POST /api/test',
      nonce: 'test',
      expiry: 1700000000,
      chainId: 42431,
    });
    expect(req.tokenAddress).toBe(STABLECOINS.AlphaUSD.address);
    expect(req.tokenSymbol).toBe('AlphaUSD');
  });
});

describe('STABLECOINS', () => {
  test('pathUSD has 6 decimals', () => {
    expect(STABLECOINS.pathUSD.decimals).toBe(6);
  });

  test('all stablecoins have valid addresses', () => {
    for (const [name, info] of Object.entries(STABLECOINS)) {
      expect(info.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(info.decimals).toBe(6);
    }
  });
});

describe('tempoTestnet', () => {
  test('has correct chain ID', () => {
    expect(tempoTestnet.id).toBe(42431);
  });

  test('has RPC URL', () => {
    expect(tempoTestnet.rpcUrls.default.http[0]).toContain('tempo.xyz');
  });
});
