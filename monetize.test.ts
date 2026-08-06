import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { monetize, MemoryNonceStore } from "./monetize";

describe("x402 Monetize Middleware Test Suite", () => {
  let app: Hono;
  let mockFetch: ReturnType<typeof vi.fn>;

  const TEST_OPTIONS = {
    price: "0.01",
    payTo: "0x1111111111111111111111111111111111111111",
    platformWallet: "0x2222222222222222222222222222222222222222",
    platformFeeBps: 50,
    facilitatorUrl: "https://mock-facilitator.test",
    nonceStore: new MemoryNonceStore()
  };

  beforeEach(() => {
    app = new Hono();
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    // Attach middleware to test route
    app.use("/api/data", monetize(TEST_OPTIONS));
    app.get("/api/data", (c) => c.json({ data: "secret_value" }));
  });

  it("1. Returns HTTP 402 with PAYMENT-REQUIRED header when no signature is provided", async () => {
    const res = await app.request("http://localhost/api/data");

    expect(res.status).toBe(402);
    
    const requiredHeader = res.headers.get("PAYMENT-REQUIRED");
    expect(requiredHeader).not.toBeNull();

    // Decode base64 header payload
    const decoded = JSON.parse(atob(requiredHeader!));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].payTo).toBe(TEST_OPTIONS.payTo);
    expect(decoded.accepts[0].amount).toBe("9950"); // $0.01 minus 0.5% platform fee
  });

  it("2. Returns HTTP 400 for malformed/short signature", async () => {
    const res = await app.request("http://localhost/api/data", {
      headers: { "PAYMENT-SIGNATURE": "123" }
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid PAYMENT-SIGNATURE format");
  });

  it("3. Successfully processes valid payment signature and hits route handler", async () => {
    const validSignature = "0x" + "a".repeat(130);

    // Mock successful settlement from facilitator
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, txHash: "0xabc123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    const res = await app.request("http://localhost/api/data", {
      headers: { "PAYMENT-SIGNATURE": validSignature }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBe("secret_value");

    const responseHeader = res.headers.get("PAYMENT-RESPONSE");
    expect(responseHeader).not.toBeNull();
    expect(JSON.parse(atob(responseHeader!)).txHash).toBe("0xabc123");
  });

  it("4. Blocks duplicate PAYMENT-SIGNATURE with HTTP 409 Replay Attack error", async () => {
    const reusedSignature = "0x" + "b".repeat(130);

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    // First Call (Success)
    const res1 = await app.request("http://localhost/api/data", {
      headers: { "PAYMENT-SIGNATURE": reusedSignature }
    });
    expect(res1.status).toBe(200);

    // Second Call with same signature (Replay blocked before hitting fetch)
    const res2 = await app.request("http://localhost/api/data", {
      headers: { "PAYMENT-SIGNATURE": reusedSignature }
    });
    expect(res2.status).toBe(409);
    
    const body = await res2.json();
    expect(body.error).toBe("Replay attack detected");
  });
});