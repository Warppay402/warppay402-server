import { MonetizeOptions, MemoryNonceStore, NonceStore } from "./monetize";

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  handler: (args: any, extraContext?: any) => Promise<any>;
}

const DEFAULT_USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULT_NETWORK = "eip155:8453";
const DEFAULT_FACILITATOR = "https://facilitator.x402.org/v2";
const DEFAULT_PLATFORM_WALLET = "0x2bd4e0ea72e21155ec41f8613eafd433193c4d8b";
const defaultMemoryStore = new MemoryNonceStore();

function parseTokenUnits(priceStr: string): bigint {
  const normalized = String(priceStr).trim();
  if (!normalized || isNaN(Number(normalized)) || Number(normalized) <= 0) {
    throw new Error(`[Monetize] Invalid price option: "${priceStr}". Must be a positive decimal number.`);
  }

  const [whole, fraction = ""] = normalized.split(".");
  const paddedFraction = fraction.padEnd(6, "0").slice(0, 6);
  return BigInt(whole + paddedFraction);
}

async function hashSignature(signature: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(signature);
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error("[Monetize] Web Crypto API (crypto.subtle) is unavailable in this environment.");
  }
  const hashBuffer = await cryptoObj.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createMonetizedMCPTool(
  tool: MCPToolDefinition,
  options: MonetizeOptions
) {
  // Validate EVM wallet addresses
  if (!options.payTo || !options.payTo.startsWith("0x") || options.payTo.length !== 42) {
    throw new Error("[Monetize] A valid 42-character EVM wallet address is required for 'payTo'.");
  }

  const asset = options.asset || DEFAULT_USDC_BASE;
  const network = options.network || DEFAULT_NETWORK;
  const facilitatorUrl = options.facilitatorUrl || DEFAULT_FACILITATOR;
  const platformFeeBps = options.platformFeeBps ?? 50;
  const platformWallet = options.platformWallet || DEFAULT_PLATFORM_WALLET;
  const nonceStore = options.nonceStore || defaultMemoryStore;
  const nonceTtlSeconds = options.nonceTtlSeconds ?? 300;
  const timeoutMs = options.timeoutMs ?? 8000;

  if (platformFeeBps > 0 && (!platformWallet || !platformWallet.startsWith("0x") || platformWallet.length !== 42)) {
    throw new Error("[Monetize] A valid EVM 'platformWallet' address is required when platformFeeBps > 0.");
  }

  const baseUnits = parseTokenUnits(options.price);
  const platformFeeUnits = (baseUnits * BigInt(platformFeeBps)) / BigInt(10_000);
  const merchantUnits = baseUnits - platformFeeUnits;

  return {
    ...tool,
    description: `${tool.description} [Requires Payment: $${options.price} USDC]`,
    async handler(args: any, context: any) {
      // Extract payment headers passed via MCP JSON-RPC request context
      const headers = context?.requestHeaders || context?.headers || {};
      const paymentSignature = headers["payment-signature"] || headers["PAYMENT-SIGNATURE"];
      const targetUrl = context?.requestUrl || `mcp://tools/${tool.name}`;

      // STEP 1: If no signature is provided, throw standard 402 challenge
      if (!paymentSignature) {
        const challengePayload = {
          code: 402,
          message: "HTTP 402 Payment Required",
          x402Challenge: {
            x402Version: 2,
            resource: {
              url: targetUrl,
              description: options.description || tool.description,
              mimeType: "application/json"
            },
            accepts: [
              {
                scheme: "exact",
                network,
                amount: merchantUnits.toString(),
                asset,
                payTo: options.payTo,
                maxTimeoutSeconds: nonceTtlSeconds,
                extra: {
                  platformFee: platformFeeUnits.toString(),
                  platformWallet: platformWallet
                }
              }
            ]
          }
        };
        throw new Error(JSON.stringify(challengePayload));
      }

      // STEP 2: Format Validation
      if (paymentSignature.length < 10) {
        throw new Error(JSON.stringify({ code: 400, message: "Invalid PAYMENT-SIGNATURE format" }));
      }

      // STEP 3: Nonce Check - Prevent Replay Attacks across MCP calls
      const signatureHash = await hashSignature(paymentSignature);
      const isUnique = await nonceStore.claim(signatureHash, nonceTtlSeconds);

      if (!isUnique) {
        throw new Error(
          JSON.stringify({
            code: 409,
            message: "Replay attack detected. PAYMENT-SIGNATURE has already been used."
          })
        );
      }

      // STEP 4: Settle via Facilitator
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const settleResponse = await fetch(`${facilitatorUrl}/settle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            paymentSignature,
            resource: { url: targetUrl },
            expectedAmount: baseUnits.toString(),
            payTo: options.payTo,
            platformWallet: platformWallet,
            platformFee: platformFeeUnits.toString()
          })
        });

        clearTimeout(timeoutId);

        const rawText = await settleResponse.text();
        let settlement: any = {};
        try {
          settlement = JSON.parse(rawText);
        } catch {
          await nonceStore.release(signatureHash);
          throw new Error(JSON.stringify({ code: 502, message: "Facilitator returned invalid non-JSON response" }));
        }

        if (!settleResponse.ok || !settlement.success) {
          await nonceStore.release(signatureHash);
          throw new Error(
            JSON.stringify({
              code: 402,
              message: "Payment verification failed",
              details: settlement.error
            })
          );
        }

        // STEP 5: Payment verified and settled -> Execute tool handler
        const result = await tool.handler(args, context);

        // Append settlement metadata to response if result is an object
        if (typeof result === "object" && result !== null) {
          return {
            ...result,
            _x402Settlement: settlement
          };
        }

        return result;
      } catch (err: any) {
        await nonceStore.release(signatureHash);
        if (err.message?.startsWith("{")) {
          throw err; // Re-throw formatted JSON error
        }
        const isTimeout = err.name === "AbortError";
        throw new Error(
          JSON.stringify({
            code: 504,
            message: isTimeout ? "Facilitator settlement timed out" : "Facilitator network error during settlement",
            details: err.message
          })
        );
      }
    }
  };
}