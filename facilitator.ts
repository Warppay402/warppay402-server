import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createWalletClient, http, parseAbi, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const app = new Hono();

const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`;
if (!FACILITATOR_PRIVATE_KEY) {
  console.error("Please set FACILITATOR_PRIVATE_KEY with a Base gas-holding key.");
  process.exit(1);
}

const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(process.env.RPC_URL || "https://mainnet.base.org")
});

// ⬇️ CHANGED TO transferWithAuthorization
const usdcAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external"
]);

app.post("/settle", async (c) => {
  try {
    const body = await c.req.json();
    
    const nested = body.paymentPayload || body.payload || {};
    const signature = nested.signature || body.signature;
    const authorization = nested.authorization || body.authorization;

    if (!signature || !authorization) {
      return c.json({ success: false, error: "Missing signature or authorization payload" }, 400);
    }

    // 1. Verify EIP-712 Signature Off-Chain
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`
    } as const;

    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }
      ]
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
        nonce: authorization.nonce
      },
      signature
    });

    if (!isValid) {
      return c.json({ success: false, error: "Invalid EIP-712 signature" }, 402);
    }

    // 2. Extract v, r, s
    const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
    const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
    const v = parseInt(signature.slice(130, 132), 16);

    // 3. Broadcast to Base Mainnet using transferWithAuthorization
    const txHash = await walletClient.writeContract({
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      abi: usdcAbi,
      functionName: "transferWithAuthorization", // ⬇️ CHANGED FUNCTION NAME
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        v,
        r,
        s
      ]
    });

    return c.json({
      success: true,
      txHash,
      network: "eip155:8453"
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`[Self-Hosted Facilitator] Running on http://localhost:${info.port}`);
});