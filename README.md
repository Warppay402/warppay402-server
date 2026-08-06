# @x402/monetize

> Instant x402 V2 monetization SDK for Model Context Protocol (MCP) tools, Hono HTTP APIs, Cloudflare Monetization Gateway, and Base.

`@x402/monetize` allows developers to monetize any MCP tool or HTTP API route in a few lines of code. It automatically generates standard x402 V2 HTTP payment challenges, verifies payment signatures, enforces platform fee splits, and prevents signature replay attacks.

---

## Features

- **x402 V2 Compliant:** Standardized payment challenge headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`).
- **Base Network Native:** Uses USDC on Base mainnet (`eip155:8453`) by default.
- **Automated Platform Fee Split:** Configurable fee split in basis points (e.g. 50 BPS = 0.5%) routed directly during facilitator settlement.
- **MCP Native Decorator:** Seamlessly wraps tools written for the Model Context Protocol.
- **Replay Protection:** Includes built-in `MemoryNonceStore` and distributed `RedisNonceStore` drivers to prevent double-spending or signature reuse.
- **Edge Compatible:** Zero Node.js-only API dependencies; runs seamlessly on Cloudflare Workers, Vercel Edge, Node.js (18+), and Deno.

---

## Installation

```bash
npm install @x402/monetize hono

Usage
1. Monetizing Hono HTTP APIs

TypeScript

import { Hono } from "hono";
import { monetize } from "@x402/monetize";

const app = new Hono();

app.use(
  "/api/data",
  monetize({
    price: "0.01", // $0.01 USDC
    payTo: "0xYourMerchantWalletAddress",
    platformWallet: "0xYourPlatformTreasuryWallet",
    platformFeeBps: 50 // 0.5% cut
  })
);

app.get("/api/data", (c) => c.json({ status: "success", content: "Monetized Payload" }));

export default app;

2. Monetizing MCP (Model Context Protocol) Tools

import { createMonetizedMCPTool } from "@x402/monetize";

const originalTool = {
  name: "web_scraper",
  description: "Extract clean Markdown content from URLs",
  inputSchema: { type: "object", properties: { url: { type: "string" } } },
  handler: async ({ url }) => {
    return { markdown: "# Cleaned Markdown Content" };
  }
};

export const monetizedTool = createMonetizedMCPTool(originalTool, {
  price: "0.02", // $0.02 USDC
  payTo: "0xYourMerchantWalletAddress",
  platformWallet: "0xYourPlatformTreasuryWallet",
  platformFeeBps: 50
});

Distributed Nonce Locking with Redis / Upstash

To enforce replay protection across serverless scale or multi-region instances, pass RedisNonceStore:

import { Redis } from "@upstash/redis";
import { monetize, RedisNonceStore } from "@x402/monetize";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!
});

app.use(
  "/api/v1/compute",
  monetize({
    price: "0.10",
    payTo: "0xYourMerchantWalletAddress",
    platformWallet: "0xYourPlatformTreasuryWallet",
    nonceStore: new RedisNonceStore(redis),
    nonceTtlSeconds: 300
  })
);

License:MIT