import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMonetizedMCPTool } from "./mcpWrapper";
import { MemoryNonceStore } from "./monetize";

describe("x402 MCP Tool Wrapper Test Suite", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  const TEST_OPTIONS = {
    price: "0.02",
    payTo: "0x1111111111111111111111111111111111111111",
    platformWallet: "0x2222222222222222222222222222222222222222",
    platformFeeBps: 50,
    facilitatorUrl: "https://mock-facilitator.test",
    nonceStore: new MemoryNonceStore()
  };

  const sampleTool = {
    name: "web_search",
    description: "Search the web for real-time information",
    inputSchema: { type: "object" },
    handler: async (args: { query: string }) => {
      return { results: [`Search results for ${args.query}`] };
    }
  };

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;
  });

  it("1. Throws HTTP 402 challenge JSON when payment-signature header is missing", async () => {
    const monetizedTool = createMonetizedMCPTool(sampleTool, TEST_OPTIONS);

    await expect(monetizedTool.handler({ query: "base crypto" }, {})).rejects.toThrow();

    try {
      await monetizedTool.handler({ query: "base crypto" }, {});
    } catch (err: any) {
      const challenge = JSON.parse(err.message);
      expect(challenge.code).toBe(402);
      expect(challenge.x402Challenge.accepts[0].amount).toBe("19900"); // $0.02 - 0.5% fee
    }
  });

  it("2. Successfully settles payment and executes underlying tool handler", async () => {
    const monetizedTool = createMonetizedMCPTool(sampleTool, TEST_OPTIONS);
    const validSig = "0x" + "c".repeat(130);

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, txHash: "0xsettled" }), { status: 200 })
    );

    const context = { requestHeaders: { "payment-signature": validSig } };
    const result = await monetizedTool.handler({ query: "base crypto" }, context);

    expect(result.results[0]).toBe("Search results for base crypto");
    expect(result._x402Settlement.txHash).toBe("0xsettled");
  });
});