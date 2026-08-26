import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createWalletClient, http, parseAbi, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { Connection, VersionedTransaction } from "@solana/web3.js";

const app = new Hono();

// Base Viem Setup
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`;
if (!FACILITATOR_PRIVATE_KEY) {
  console.error("Please set FACILITATOR_PRIVATE_KEY with a Base gas-holding key.");
  process.exit(1);
}

const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(process.env.RPC_URL || "https://mainnet.base.org"),
});

// Solana RPC Setup
const solanaConnection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed"
);

const usdcAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
]);

const handleSettle = async (c: any) => {
  try {
    const body = await c.req.json();

    // Check if request is a Solana Settlement
    const isSolana = 
      body.network?.includes("solana") || 
      body.paymentRequirements?.network?.includes("solana") ||
      body.paymentPayload?.network?.includes("solana");

    if (isSolana) {
      // 1. Extract serialized Solana transaction
      const serializedTx = body.signature || body.paymentPayload?.signature || body.serializedTransaction;
      if (!serializedTx) {
        return c.json({ success: false, error: "Missing Solana transaction payload" }, 400);
      }

      // 2. Decode and broadcast Versioned Transaction to Solana L1
      const txBuffer = Buffer.from(serializedTx, "base64");
      const transaction = VersionedTransaction.deserialize(txBuffer);
      
      const txHash = await solanaConnection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      return c.json({
        success: true,
        txHash,
        network: "solana:5eykt4wA89m8E5b9B5658p445VTc28",
      });
    }

    // Default EVM (Base) Settlement Path
    const authorization = 
      body.authorization || 
      body.payload?.authorization || 
      body.paymentPayload?.authorization || 
      body.paymentPayload?.payload?.authorization;

    const signature = 
      body.signature || 
      body.payload?.signature || 
      body.paymentPayload?.signature || 
      body.paymentPayload?.payload?.signature;

    if (!signature || !authorization) {
      return c.json({ success: false, error: "Missing signature or authorization payload" }, 400);
    }

    // Verify & Broadcast EVM EIP-712
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
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

    if (!isValid) {
      return c.json({ success: false, error: "Invalid EIP-712 signature" }, 402);
    }

    const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
    const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
    const v = parseInt(signature.slice(130, 132), 16);

    const txHash = await walletClient.writeContract({
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
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
    });

    return c.json({
      success: true,
      txHash,
      network: "eip155:8453",
    });
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