import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  verifyTypedData,
  parseGwei,
  defineChain,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arbitrum } from "viem/chains";
import { Connection, VersionedTransaction } from "@solana/web3.js";

const app = new Hono();

// ==========================================
// ENVIRONMENT & ACCOUNT INITIALIZATION
// ==========================================

const rawKey = (
  process.env.FACILITATOR_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  ""
).trim();

if (!rawKey || rawKey.includes("insert_your_new_private_key_here")) {
  console.error("❌ Facilitator Startup Error: Missing or placeholder private key in .env");
  process.exit(1);
}

const formattedPk = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;

if (!/^0x[0-9a-fA-F]{64}$/.test(formattedPk)) {
  console.error("❌ Facilitator Startup Error: Private key must be a valid 64-hex-character string.");
  process.exit(1);
}

const account = privateKeyToAccount(formattedPk);

// ==========================================
// 1. ARC MAINNET CHAIN & CLIENT DEFINITION
// ==========================================
export const arcMainnet: Chain = defineChain({
  id: 5042,
  name: "Arc Mainnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.arc.io"] },
    public: { http: ["https://rpc.mainnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://explorer.arc.io" },
  },
});

const ARC_RPC_URL = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const arcPublicClient = createPublicClient({ chain: arcMainnet, transport: http(ARC_RPC_URL) });

// ==========================================
// 2. EVM & SOLANA CLIENT INITIALIZATION
// ==========================================
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://rpc.ankr.com/base";
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL || "https://rpc.ankr.com/arbitrum";

const basePublicClient = createPublicClient({ chain: base, transport: http(BASE_RPC_URL) });
const baseWalletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC_URL) });

const arbPublicClient = createPublicClient({ chain: arbitrum, transport: http(ARBITRUM_RPC_URL) });
const arbWalletClient = createWalletClient({ account, chain: arbitrum, transport: http(ARBITRUM_RPC_URL) });

// Solana RPC Client
const solanaConnection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

const usdcAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
]);

// ==========================================
// 3. EIP-3009 NONCE TRACKER (DOUBLE-SPEND GUARD)
// ==========================================
class SpentNonceStore {
  private spentNonces = new Map<string, number>();

  public hasSpentNonce(nonce: string): boolean {
    const key = nonce.toLowerCase();
    const expiry = this.spentNonces.get(key);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.spentNonces.delete(key);
      return false;
    }
    return true;
  }

  public recordSpentNonce(nonce: string, ttlMs: number = 24 * 60 * 60 * 1000): void {
    const key = nonce.toLowerCase();
    this.spentNonces.set(key, Date.now() + ttlMs);
  }
}

const nonceStore = new SpentNonceStore();

// ==========================================
// 4. EVM TRANSACTION SERIALIZATION QUEUE
// ==========================================
class EvmTxMutex {
  private queue: Promise<void> = Promise.resolve();

  public runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  }
}

const evmQueueMap = new Map<number, EvmTxMutex>();

function getTxMutex(chainId: number): EvmTxMutex {
  if (!evmQueueMap.has(chainId)) {
    evmQueueMap.set(chainId, new EvmTxMutex());
  }
  return evmQueueMap.get(chainId)!;
}

// ==========================================
// 5. SETTLEMENT HANDLER
// ==========================================
const handleSettle = async (c: any) => {
  try {
    const body = await c.req.json();
    const network = body.network || body.paymentRequirements?.network || body.paymentPayload?.network || "eip155:8453";

    // 1. SOLANA PATH
    if (network.includes("solana")) {
      const serializedTx = body.signature || body.paymentPayload?.signature || body.serializedTransaction || body.payload?.signature;
      if (!serializedTx) return c.json({ success: false, error: "Missing Solana payload" }, 400);

      const txBuffer = Buffer.from(serializedTx, "base64");
      const transaction = VersionedTransaction.deserialize(txBuffer);
      const txHash = await solanaConnection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });

      return c.json({ success: true, txHash, network: "solana:5eykt4wA89m8E5b9B5658p445VTc28" });
    }

    // 2. ARC MAINNET NATIVE USDC PATH
    const isArc = network === "eip155:5042";
    if (isArc) {
      const authorization = body.authorization || body.payload?.authorization || body.paymentPayload?.authorization || {};
      const txHash = body.txHash || body.signature || body.paymentPayload?.signature || body.payload?.signature;

      if (!txHash) {
        return c.json({ success: false, error: "Missing transaction hash for Arc settlement verification" }, 400);
      }

      // On Arc, USDC is native currency—verify standard tx receipt, payee, and value
      const tx = await arcPublicClient.getTransaction({ hash: txHash as `0x${string}` });
      const receipt = await arcPublicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });

      const targetPayee = (authorization.to || body.paymentRequirements?.payTo || "").toLowerCase();
      const requiredValue = BigInt(authorization.value || body.paymentRequirements?.amount || "0");

      const isValidPayee = !targetPayee || tx.to?.toLowerCase() === targetPayee;
      const isValidAmount = tx.value >= requiredValue;

      if (receipt.status === "success" && isValidPayee && isValidAmount) {
        return c.json({ success: true, txHash, network: "eip155:5042" });
      } else {
        return c.json({ success: false, error: "Arc native USDC transaction verification failed" }, 400);
      }
    }

    // 3. EVM EIP-712 AUTHORIZATION PATH (Base & Arbitrum)
    const authorization = body.authorization || body.payload?.authorization || body.paymentPayload?.authorization;
    const signature = body.signature || body.payload?.signature || body.paymentPayload?.signature;

    if (!signature || !authorization) {
      return c.json({ success: false, error: "Missing signature or authorization payload" }, 400);
    }

    // Check if EIP-3009 authorization nonce was already spent
    if (authorization.nonce && nonceStore.hasSpentNonce(authorization.nonce)) {
      return c.json({ success: false, error: "EIP-3009 authorization nonce already executed" }, 409);
    }

    const isArbitrum = network === "eip155:42161";
    const chainId = isArbitrum ? 42161 : 8453;
    const usdcAddress = isArbitrum
      ? "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" // Arbitrum Native USDC
      : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base Native USDC

    const ALLOWED_DOMAINS: Record<string, { name: string; version: string }> = {
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USD Coin", version: "2" }, // Base USDC
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { name: "USD Coin", version: "2" }, // Arbitrum USDC
    };

    const tokenLower = usdcAddress.toLowerCase();
    const expectedDomain = ALLOWED_DOMAINS[tokenLower] || { name: "USD Coin", version: "2" };

    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const;

    const message = {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    };

    // EIP-712 Domain Version Fallback (Tries v2, falls back to v1)
    let isValid = await verifyTypedData({
      address: authorization.from,
      domain: {
        name: expectedDomain.name,
        version: "2",
        chainId,
        verifyingContract: usdcAddress as `0x${string}`,
      },
      types,
      primaryType: "TransferWithAuthorization",
      message,
      signature,
    });

    if (!isValid) {
      isValid = await verifyTypedData({
        address: authorization.from,
        domain: {
          name: expectedDomain.name,
          version: "1",
          chainId,
          verifyingContract: usdcAddress as `0x${string}`,
        },
        types,
        primaryType: "TransferWithAuthorization",
        message,
        signature,
      });
    }

    if (!isValid) return c.json({ success: false, error: "Invalid EIP-712 signature" }, 402);

    const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
    const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
    let v = parseInt(signature.slice(130, 132), 16);
    if (v < 27) v += 27;

    const targetPublicClient = isArbitrum ? arbPublicClient : basePublicClient;
    const targetWalletClient = isArbitrum ? arbWalletClient : baseWalletClient;

    // Mutex execution block prevents EVM nonce collision under high concurrency
    const mutex = getTxMutex(chainId);
    const txHash = await mutex.runExclusive(async () => {
      const [pendingNonce, gasPrice] = await Promise.all([
        targetPublicClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        }),
        targetPublicClient.getGasPrice(),
      ]);

      const maxPriorityFeePerGas = parseGwei("0.1");
      const maxFeePerGas = gasPrice + maxPriorityFeePerGas;

      return await targetWalletClient.writeContract({
        address: usdcAddress as `0x${string}`,
        abi: usdcAbi,
        functionName: "transferWithAuthorization",
        args: [
          authorization.from,
          authorization.to,
          BigInt(authorization.value),
          BigInt(authorization.validAfter),
          BigInt(authorization.validBefore),
          authorization.nonce,
          v,
          r,
          s,
        ],
        nonce: pendingNonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    });

    // Record nonce in spent store
    if (authorization.nonce) {
      nonceStore.recordSpentNonce(authorization.nonce);
    }

    return c.json({ success: true, txHash, network: `eip155:${chainId}` });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
};

// ==========================================
// 6. ROUTES AND SERVER LIFECYCLE
// ==========================================
app.get("/health", (c) => c.json({ status: "healthy", facilitator: account.address }));
app.post("/", handleSettle);
app.post("/settle", handleSettle);
app.post("/verify", handleSettle);

serve({ fetch: app.fetch, port: 3001, hostname: "127.0.0.1" }, (info) => {
  console.log(`🚀 [Self-Hosted Facilitator] Online with address: ${account.address}`);
  console.log(`   Listening on http://127.0.0.1:${info.port}`);
});