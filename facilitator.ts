import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPublicClient, createWalletClient, http, parseAbi, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arbitrum } from "viem/chains"; // Import Arbitrum Chain
import { Connection, VersionedTransaction } from "@solana/web3.js";

const app = new Hono();

const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`;
if (!FACILITATOR_PRIVATE_KEY) {
  console.error("Please set FACILITATOR_PRIVATE_KEY.");
  process.exit(1);
}

const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);

// Base Clients
const basePublicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const baseWalletClient = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });

// Arbitrum Clients
const arbPublicClient = createPublicClient({ chain: arbitrum, transport: http(process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc") });
const arbWalletClient = createWalletClient({ account, chain: arbitrum, transport: http(process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc") });

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
      const serializedTx = body.signature || body.paymentPayload?.signature || body.serializedTransaction;
      if (!serializedTx) return c.json({ success: false, error: "Missing Solana payload" }, 400);

      const txBuffer = Buffer.from(serializedTx, "base64");
      const transaction = VersionedTransaction.deserialize(txBuffer);
      const txHash = await solanaConnection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });

      return c.json({ success: true, txHash, network: "solana:5eykt4wA89m8E5b9B5658p445VTc28" });
    }

    // 2. EVM PATH (Base & Arbitrum)
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
    const v = parseInt(signature.slice(130, 132), 16);

    const targetPublicClient = isArbitrum ? arbPublicClient : basePublicClient;
    const targetWalletClient = isArbitrum ? arbWalletClient : baseWalletClient;

    const pendingNonce = await targetPublicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    });

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
    });

    return c.json({ success: true, txHash, network: `eip155:${chainId}` });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
};

app.post("/", handleSettle);
app.post("/settle", handleSettle);
app.post("/verify", handleSettle);

serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`[Self-Hosted Facilitator] Running on http://localhost:${info.port}`);
});