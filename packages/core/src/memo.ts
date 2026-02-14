import { keccak256, encodePacked } from 'viem';

/**
 * Create a 32-byte memo that fingerprints a payment request.
 * Encodes: endpoint + bodyHash + nonce + expiry → keccak256
 */
export function createMemo(
  endpoint: string,
  bodyHash: string,
  nonce: string,
  expiry: number,
): `0x${string}` {
  return keccak256(
    encodePacked(
      ['string', 'string', 'string', 'uint256'],
      [endpoint, bodyHash, nonce, BigInt(expiry)],
    ),
  );
}

/**
 * Verify that a memo matches the expected parameters.
 */
export function verifyMemo(
  memo: `0x${string}`,
  endpoint: string,
  bodyHash: string,
  nonce: string,
  expiry: number,
): boolean {
  const expected = createMemo(endpoint, bodyHash, nonce, expiry);
  return memo.toLowerCase() === expected.toLowerCase();
}
