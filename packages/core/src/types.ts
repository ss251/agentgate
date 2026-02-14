/** Payment requirement returned in HTTP 402 response */
export interface PaymentRequired {
  network: 'tempo';
  chainId: number;
  recipient: `0x${string}`;
  token: `0x${string}`;
  amount: string;
  memo: `0x${string}`;
  expiry: number;
  endpoint: string;
  description: string;
}

/** Service configuration for pricing an endpoint */
export interface ServiceConfig {
  price: string;
  description: string;
  token?: `0x${string}`;
}

/** Receipt after successful on-chain payment verification */
export interface PaymentReceipt {
  txHash: `0x${string}`;
  blockNumber: bigint;
  from: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
  memo: `0x${string}`;
  timestamp: number;
}

/** Service announcement served at /.well-known/agentgate.json */
export interface AgentRegistration {
  name: string;
  description: string;
  image?: string;
  services: Array<{
    name: string;
    endpoint: string;
    price?: string;
    token?: string;
    description?: string;
  }>;
  x402Support: boolean;
  active: boolean;
  wallet: `0x${string}`;
}

/** Feedback after a service call for reputation tracking */
export interface ServiceFeedback {
  serviceEndpoint: string;
  value: number;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  txHash?: `0x${string}`;
}

/** Result of payment verification */
export interface VerifyResult {
  valid: boolean;
  receipt?: PaymentReceipt;
  error?: string;
}
