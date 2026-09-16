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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arbitrum } from "viem/chains";
import { Connection, VersionedTransaction } from "@solana/web3.js";

const app = new Hono();

// Flexible key handling with strict validation
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
export const arcMainnet = defineChain({
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

    const isArbitrum = network === "eip155:42161";
    const chainId = isArbitrum ? 42161 : 8453;
    const usdcAddress = isArbitrum 
      ? "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" // Arbitrum Native USDC
      : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base Native USDC

    const domain = {
      name: "USD Coin",
      version: "2",
      chainId,
      verifyingContract: usdcAddress as `0x${string}`,
    } as const;

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

    const isValid = await verifyTypedData({
      address: authorization.from,
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    });

    if (!isValid) return c.json({ success: false, error: "Invalid EIP-712 signature" }, 402);

    const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
    const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
    let v = parseInt(signature.slice(130, 132), 16);
    if (v < 27) v += 27; // EIP-155 v parameter normalization guard

    const targetPublicClient = isArbitrum ? arbPublicClient : basePublicClient;
    const targetWalletClient = isArbitrum ? arbWalletClient : baseWalletClient;

    // Parallelize Nonce and Gas Price fetching to eliminate round-trip latency
    const [pendingNonce, gasPrice] = await Promise.all([
      targetPublicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
      targetPublicClient.getGasPrice(),
    ]);

    // ==========================================
    // OPTIMISTIC GAS BUMPING (EIP-1559)
    // ==========================================
    // Add 0.1 gwei priority fee to guarantee immediate inclusion in next block
    const maxPriorityFeePerGas = parseGwei("0.1");
    const maxFeePerGas = gasPrice + maxPriorityFeePerGas;

    const txHash = await targetWalletClient.writeContract({
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

    return c.json({ success: true, txHash, network: `eip155:${chainId}` });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
};

// Routes for settlement, verification, and healthchecks
app.get("/health", (c) => c.json({ status: "healthy", facilitator: account.address }));
app.post("/", handleSettle);
app.post("/settle", handleSettle);
app.post("/verify", handleSettle);

serve({ fetch: app.fetch, port: 3001, hostname: "127.0.0.1" }, (info) => {
  console.log(`🚀 [Self-Hosted Facilitator] Online with address: ${account.address}`);
  console.log(`   Listening on http://127.0.0.1:${info.port}`);
});