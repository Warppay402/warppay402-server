import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
if (!PRIVATE_KEY) {
  console.error("Please set process.env.PRIVATE_KEY");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http("https://mainnet.base.org")
});

const API_URL = process.env.API_URL || "http://localhost:3000/api/weather";

async function executeAgentPayment() {
  console.log(`[Agent] Probing endpoint: ${API_URL}`);

  // Step 1: Retrieve 402 challenge
  const initialRes = await fetch(API_URL);
  if (initialRes.status !== 402) {
    console.log("[Agent] Endpoint did not request x402 payment.");
    return;
  }

  const paymentRequiredHeader = initialRes.headers.get("PAYMENT-REQUIRED");
  if (!paymentRequiredHeader) {
    throw new Error("Missing PAYMENT-REQUIRED header from server");
  }

  const challenge = JSON.parse(atob(paymentRequiredHeader));
  const requirement = challenge.accepts[0];

  console.log(`[Agent] Payment required: $${Number(requirement.amount) / 1e6} USDC on Base`);

  // Step 2: Sign EIP-712 payment authorization
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: requirement.asset as `0x${string}`
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

  const now = Math.floor(Date.now() / 1000);
  const nonce = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;

  const authorization = {
    from: account.address,
    to: requirement.payTo as `0x${string}`,
    value: requirement.amount,
    validAfter: (now - 60).toString(),
    validBefore: (now + requirement.maxTimeoutSeconds).toString(),
    nonce
  };

  const signatureHex = await walletClient.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: requirement.payTo as `0x${string}`,
      value: BigInt(requirement.amount),
      validAfter: BigInt(now - 60),
      validBefore: BigInt(now + requirement.maxTimeoutSeconds),
      nonce
    }
  });

  // Step 3: Construct root-level payment payload compatible with XPay relayer
  const paymentSignaturePayload = JSON.stringify({
    x402Version: 2,
    scheme: "exact",
    network: "eip155:8453",
    signature: signatureHex,
    authorization,
    paymentRequirements: requirement
  });

  const encodedSignature = btoa(paymentSignaturePayload);

  // Step 4: Resubmit with PAYMENT-SIGNATURE header
  console.log("[Agent] Submitting signed authorization to server...");
  const paidRes = await fetch(API_URL, {
    headers: {
      "PAYMENT-SIGNATURE": encodedSignature
    }
  });

  const responseData = await paidRes.json();
  console.log(`[Server Status]: ${paidRes.status}`);
  console.log("[Server Payload]:", responseData);
}

executeAgentPayment().catch(console.error);