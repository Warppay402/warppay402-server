import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { monetize } from "@golfgolfgolf200/x402-monetize";

const app = new Hono();

// 1. Unmonetized health check endpoint
app.get("/health", (c) => c.text("Server is healthy!"));

// 2. Protect a route with x402 monetization
app.use(
  "/api/v1/paid-data",
  monetize({
    price: "0.05", // $0.05 USDC per request (must be a string)
    payTo: "0x1234567890123456789012345678901234567890", // EVM payout wallet
  })
);

// 3. Monetized API route payload
app.get("/api/v1/paid-data", (c) => {
  return c.json({
    success: true,
    message: "Access granted! Payment verified successfully.",
    data: {
      insight: "Monetized API responses delivered seamlessly over x402.",
      timestamp: new Date().toISOString(),
    },
  });
});

const port = 3000;
console.log(`🚀 Monetized server running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});