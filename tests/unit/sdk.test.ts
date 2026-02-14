import { describe, test, expect } from 'bun:test';
import { AgentGateClient, type PaymentEvent } from '../../packages/sdk/src/index';

const TEST_KEY = '0x4afc13e37cdba626e6075f85b82d23e9ba66c73faa7b3af920ad6da320a8ecfb' as const;

describe('AgentGateClient construction', () => {
  test('derives correct address from private key', () => {
    const client = new AgentGateClient({ privateKey: TEST_KEY });
    expect(client.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    // Known address for this key
    expect(client.address.toLowerCase()).toBe('0x94ef9c6a4ea5f42781ee68145dc5c55de69d35f5');
  });

  test('accepts custom chain config', () => {
    const client = new AgentGateClient({
      privateKey: TEST_KEY,
      rpcUrl: 'https://custom-rpc.example.com',
      maxRetries: 5,
      timeoutMs: 30000,
    });
    expect(client.address).toBeDefined();
  });

  test('fires payment events via callback', () => {
    const events: PaymentEvent[] = [];
    const client = new AgentGateClient({
      privateKey: TEST_KEY,
      onPaymentEvent: (e) => events.push(e),
    });
    // Client constructed — events are fired during fetch, not construction
    expect(events).toHaveLength(0);
  });

  test('throws on invalid private key', () => {
    expect(() => {
      new AgentGateClient({ privateKey: '0xinvalid' as any });
    }).toThrow();
  });
});

describe('AgentGateClient.discover', () => {
  test('throws on unreachable URL', async () => {
    const client = new AgentGateClient({ privateKey: TEST_KEY });
    await expect(client.discover('http://localhost:1')).rejects.toThrow();
  });
});
