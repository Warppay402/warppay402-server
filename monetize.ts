import { Context, Next } from "hono";
import { x402Guard, GuardOptions } from "./guard.js";

// ============================================================================
// 1. Nonce Store Abstraction & Production Drivers
// ============================================================================

export interface NonceStore {
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
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

export class MemoryNonceStore implements NonceStore {
  private cache = new Map<string, number>();

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const expiry = this.cache.get(key);

    if (expiry !== undefined && expiry > now) {
      return false;
    }

    this.cache.set(key, now + ttlSeconds * 1000);
    this.cleanup(now);
    return true;
  }

  async release(key: string): Promise<void> {
    this.cache.delete(key);
  }

  private cleanup(now: number) {
    if (this.cache.size > 2_000) {
      for (const [k, exp] of this.cache.entries()) {
        if (exp <= now) this.cache.delete(k);
      }
    }
  }
}

export class RedisNonceStore implements NonceStore {
  constructor(
    private redisClient: {
      set: (key: string, value: string, ...args: any[]) => Promise<any>;
      del: (key: string) => Promise<any>;
    },
    private keyPrefix: string = "x402:nonce:"
  ) {}

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const redisKey = `${this.keyPrefix}${key}`;
    const result = await this.redisClient.set(redisKey, "1", "EX", ttlSeconds, "NX");
    return result === "OK" || result === 1 || result === true;
  }

  async release(key: string): Promise<void> {
    const redisKey = `${this.keyPrefix}${key}`;
    await this.redisClient.del(redisKey);
  }
}

const defaultMemoryStore = new MemoryNonceStore();

// ============================================================================
// 2. Production Monetize Middleware
// ============================================================================

export interface MonetizeOptions {
  price: string;
  payTo: string;
  asset?: string;
  network?: string;
  platformFeeBps?: number;
  platformWallet?: string;
  facilitatorUrl?: string;
  description?: string;
  nonceStore?: NonceStore;
  nonceTtlSeconds?: number;
  timeoutMs?: number;
  enableCorsHeaders?: boolean;
  guard?: boolean | GuardOptions;
  accepts?: Array<Record<string, any>>;
  extensions?: Record<string, any>;
}

const DEFAULT_USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULT_NETWORK = "eip155:8453";
const DEFAULT_FACILITATOR = "https://warppay402.com";
const DEFAULT_PLATFORM_WALLET = "0x226df5aabe192fd2181555367c2f6b99da39c184";

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function parseTokenUnits(priceStr: string): bigint {
  const normalized = String(priceStr).trim();
  if (!normalized || isNaN(Number(normalized)) || Number(normalized) <= 0) {
    throw new Error(`[Monetize] Invalid price option: "${priceStr}". Must be a positive decimal number.`);
  }

  const [whole, fraction = ""] = normalized.split(".");
  const paddedFraction = fraction.padEnd(6, "0").slice(0, 6);
  return BigInt(whole + paddedFraction);
}

export function monetize(options: MonetizeOptions) {
  // NEW MULTI-CHAIN ADDRESS CHECK
  const isEvm = options.payTo?.startsWith("0x") && options.payTo.length === 42;
  const isSolana = options.payTo && options.payTo.length >= 32 && options.payTo.length <= 44;

  if (!isEvm && !isSolana) {
    throw new Error("[Monetize] 'payTo' must be a valid EVM address (0x...) or Solana public key.");
  }

  const asset = options.asset || DEFAULT_USDC_BASE;
  const network = options.network || DEFAULT_NETWORK;
  const facilitatorUrl = options.facilitatorUrl || DEFAULT_FACILITATOR;
  const platformFeeBps = options.platformFeeBps ?? 50;
  const platformWallet = options.platformWallet || DEFAULT_PLATFORM_WALLET;
  const nonceStore = options.nonceStore || defaultMemoryStore;
  const nonceTtlSeconds = options.nonceTtlSeconds ?? 300;
  const timeoutMs = options.timeoutMs ?? 8000;
  const enableCors = options.enableCorsHeaders ?? true;

  if (platformFeeBps > 0 && (!platformWallet || !platformWallet.startsWith("0x") || platformWallet.length !== 42)) {
    throw new Error("[Monetize] A valid EVM 'platformWallet' address is required when platformFeeBps > 0.");
  }

  const baseUnits = parseTokenUnits(options.price);
  const platformFeeUnits = (baseUnits * BigInt(platformFeeBps)) / BigInt(10_000);
  const merchantUnits = baseUnits - platformFeeUnits;

  const guardMiddleware = options.guard
    ? x402Guard(typeof options.guard === "object" ? options.guard : {})
    : null;

  return async (c: Context, next: Next) => {
    if (guardMiddleware) {
      let guardPassed = false;
      const guardRes = await guardMiddleware(c, async () => {
        guardPassed = true;
      });

      if (!guardPassed) {
        return guardRes;
      }
    }

    if (enableCors) {
      c.header("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
    }

    const paymentSignature = c.req.header("payment-signature") || c.req.header("PAYMENT-SIGNATURE");
    const targetUrl = c.req.url;

    // STEP 1: Return HTTP 402 Challenge if signature is missing
    if (!paymentSignature) {
      // Force HTTPS scheme on target URL
      const cleanUrl = targetUrl.replace("http://", "https://");

      const challengePayload: Record<string, any> = {
        x402Version: 2,
        resource: {
          url: cleanUrl,
          description: options.description || "Monetized API Access",
          mimeType: "application/json"
        },
        accepts: options.accepts || [
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
      };

      // Inject extensions if configured
      if (options.extensions) {
        challengePayload.extensions = options.extensions;
      }

      c.header("PAYMENT-REQUIRED", toBase64(JSON.stringify(challengePayload)));

      // Standard x402 V2 response format (root level metadata)
      return c.json(
        {
          error: "Payment required",
          ...challengePayload
        },
        402
      );
    }

    // STEP 2: Signature format check
    if (paymentSignature.length < 10) {
      return c.json({ error: "Invalid PAYMENT-SIGNATURE format" }, 400);
    }

    // STEP 3: Nonce Claim
    const signatureHash = await hashSignature(paymentSignature);
    const isUnique = await nonceStore.claim(signatureHash, nonceTtlSeconds);

    if (!isUnique) {
      return c.json(
        {
          error: "Replay attack detected",
          details: "This PAYMENT-SIGNATURE has already been processed or submitted."
        },
        409
      );
    }

    // STEP 4: Verify & Settle via Facilitator
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let parsedPayload: any = {};
      try {
        const decodedString = atob(paymentSignature);
        parsedPayload = JSON.parse(decodedString);
      } catch {
        await nonceStore.release(signatureHash);
        return c.json({ error: "Invalid base64 payload in PAYMENT-SIGNATURE" }, 400);
      }

      const settleResponse = await fetch(`${facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          signature: parsedPayload.signature || parsedPayload.paymentPayload?.signature,
          authorization: parsedPayload.authorization || parsedPayload.paymentPayload?.authorization,
          paymentPayload: parsedPayload,
          paymentRequirements: parsedPayload.paymentRequirements,
          resource: { url: targetUrl }
        })
      });

      clearTimeout(timeoutId);

      const rawText = await settleResponse.text();
      let settlement: any = {};
      try {
        settlement = JSON.parse(rawText);
      } catch {
        await nonceStore.release(signatureHash);
        return c.json({ error: "Facilitator returned an invalid non-JSON response", status: settleResponse.status }, 502);
      }

      if (!settleResponse.ok || !settlement.success) {
        await nonceStore.release(signatureHash);
        c.header("PAYMENT-RESPONSE", toBase64(JSON.stringify({ success: false, error: settlement.error })));
        return c.json({ error: "Payment verification failed", details: settlement.error }, 402);
      }

      // STEP 5: Success
      c.header("PAYMENT-RESPONSE", toBase64(JSON.stringify(settlement)));
      await next();
    } catch (err: any) {
      await nonceStore.release(signatureHash);
      const isTimeout = err.name === "AbortError";
      return c.json(
        {
          error: isTimeout ? "Facilitator settlement timed out" : "Facilitator network error during settlement",
          message: err.message
        },
        504
      );
    }
  };
}