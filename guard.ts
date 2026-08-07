import { Context, Next } from "hono";

export interface GuardOptions {
  /** Maximum requests allowed within the window per IP/Wallet */
  rateLimitMax?: number;
  /** Rate limit window in milliseconds (default: 60000 / 1 minute) */
  rateLimitWindowMs?: number;
  /** Custom forbidden keywords/patterns for prompt injection scanning */
  customBlockedPatterns?: RegExp[];
  /** Maximum length allowed for input strings (prevents buffer overload) */
  maxPayloadLength?: number;
  /** Action on detected threat: 'block' (422) or 'log-only' */
  mode?: "block" | "log-only";
}

export interface GuardAuditResult {
  passed: boolean;
  reason?: string;
  threatType?: "PROMPT_INJECTION" | "VELOCITY_EXCEEDED" | "PAYLOAD_TOO_LARGE";
}

/**
 * Built-in heuristic signatures for common indirect prompt injection attacks
 */
const DEFAULT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /override\s+(system\s+)?prompt/i,
  /system:\s*you\s+must/i,
  /bypass\s+(payment|verification|guard|x402)/i,
  /pay\s+(maximum|all|unlimited)\s+(usdc|funds|balance)/i,
  /repeat\s+this\s+request\s+infinitely/i,
  /<script[\s\S]*?>[\s\S]*?<\/script>/i,
  /eval\(.*?\)/i,
];

/**
 * In-memory sliding window store for velocity protection
 */
class VelocityStore {
  private requests: Map<string, number[]> = new Map();

  isExceeded(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const validTimestamps = timestamps.filter((time) => now - time < windowMs);

    if (validTimestamps.length >= limit) {
      return true;
    }

    validTimestamps.push(now);
    this.requests.set(key, validTimestamps);
    return false;
  }
}

const velocityStore = new VelocityStore();

/**
 * Scans string inputs recursively within a JSON request body
 */
export function scanPayloadForInjection(
  payload: unknown,
  customPatterns: RegExp[] = []
): { safe: boolean; matchedPattern?: string } {
  const patterns = [...DEFAULT_INJECTION_PATTERNS, ...customPatterns];

  const inspectValue = (val: unknown): { safe: boolean; matchedPattern?: string } => {
    if (typeof val === "string") {
      for (const pattern of patterns) {
        if (pattern.test(val)) {
          return { safe: false, matchedPattern: pattern.toString() };
        }
      }
    } else if (typeof val === "object" && val !== null) {
      for (const key of Object.keys(val)) {
        const result = inspectValue((val as Record<string, unknown>)[key]);
        if (!result.safe) return result;
      }
    }
    return { safe: true };
  };

  return inspectValue(payload);
}

/**
 * Pre-flight Hono Middleware for x402-guard
 */
export function x402Guard(options: GuardOptions = {}) {
  const {
    rateLimitMax = 20,
    rateLimitWindowMs = 60000,
    customBlockedPatterns = [],
    maxPayloadLength = 50000,
    mode = "block",
  } = options;

  return async (c: Context, next: Next): Promise<Response | void> => {
    const clientKey = c.req.header("x-forwarded-for") || "unknown-client";

    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // Body parsing optional if request has no body
    }

    // 1. Payload Size Check
    const rawBody = JSON.stringify(body || {});
    if (rawBody.length > maxPayloadLength) {
      if (mode === "block") {
        c.header("X-Guard-Blocked", "PAYLOAD_TOO_LARGE");
        return c.json(
          {
            error: "Payload Too Large",
            message: `Request body exceeds maximum safe size of ${maxPayloadLength} characters.`,
            code: "PAYLOAD_TOO_LARGE",
          },
          413
        );
      }
    }

    // 2. Velocity Check
    if (velocityStore.isExceeded(clientKey, rateLimitMax, rateLimitWindowMs)) {
      c.header("X-Guard-Blocked", "VELOCITY_EXCEEDED");
      if (mode === "block") {
        return c.json(
          {
            error: "Rate Limit Exceeded",
            message: "Anomalous transaction velocity detected. Request blocked before x402 payment.",
            code: "VELOCITY_EXCEEDED",
          },
          429
        );
      }
    }

    // 3. Prompt Injection Pre-Flight Scan
    const scanResult = scanPayloadForInjection(body, customBlockedPatterns);
    if (!scanResult.safe) {
      c.header("X-Guard-Blocked", "PROMPT_INJECTION");
      if (mode === "block") {
        return c.json(
          {
            error: "Security Violation",
            message: "Potential prompt injection or payload manipulation detected in request body.",
            code: "PROMPT_INJECTION_DETECTED",
          },
          422
        );
      }
    }

    c.header("X-Guard-Inspected", "true");
    await next();
  };
}