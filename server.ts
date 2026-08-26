import "dotenv/config";
import { serve } from "@hono/node-server";
import { monetize } from "./monetize.js"; 
import { Hono } from "hono";

const app = new Hono();

// Define the developer's wallet address (where 99.5% of funds go)
const developerWallet = "0x2bd4e0ea72e21155ec41f8613eafd433193c4d8b";

// 1. PUBLIC HEALTH & MCP DISCOVERY ROUTES (No 402 Payment Required)
app.get("/", (c) => c.json({ status: "ok", service: "WarpPay402 Gateway" }));
app.get("/health", (c) => c.json({ status: "healthy" }));

// Redirect root /mcp.json to /.well-known/mcp.json
app.get("/mcp.json", (c) => c.redirect("/.well-known/mcp.json"));

// Standard OpenClaw & Smithery plugin manifest routes
app.get("/openclaw.plugin.json", (c) =>
  c.json({
    name: "warppay402-server",
    version: "1.0.0",
    description: "Instant MCP Tool & x402 Monetization SDK for Cloudflare Gateway and Base",
    main: "dist/index.js",
    type: "mcp-server",
    config: {
      url: "https://api.warppay402.com/.well-known/mcp.json"
    }
  })
);

app.get("/.well-known/mcp.json", (c) =>
  c.json({
    schema_version: "v1",
    name_for_model: "warppay_weather",
    name_for_human: "WarpPay Weather Tool",
    description_for_model: "Monetized weather data API on Base Mainnet via x402 micro-payments.",
    api: {
      type: "openapi",
      url: "https://api.warppay402.com/api/weather"
    }
  })
);

// MCP JSON-RPC protocol endpoint for tool discovery
app.post("/mcp", async (c) => {
  try {
    const body = await c.req.json();
    if (body.method === "tools/list" || body.method === "initialize") {
      return c.json({
        jsonrpc: "2.0",
        id: body.id ?? 1,
        result: {
          tools: [
            {
              name: "get_weather",
              description: "Fetch live city weather (Costs $0.01 USDC via x402)",
              inputSchema: {
                type: "object",
                properties: {
                  city: { type: "string", description: "City name, e.g., Austin" }
                }
              }
            }
          ]
        }
      });
    }
    return c.json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32601, message: "Method not found" } });
  } catch {
    return c.json({ jsonrpc: "2.0", id: 1, error: { code: -32700, message: "Parse error" } });
  }
});

// 2. MONETIZED API ROUTES (x402 Payment Guarded)
app.use(
  "/api/weather",
  monetize({
    price: "0.01",
    payTo: developerWallet,
    platformWallet: "0x2bd4e0ea72e21155ec41f8613eafd433193c4d8b",
    platformFeeBps: 50,
    facilitatorUrl: "https://warppay402.com" 
  })
);

app.get("/api/weather", (c) => {
  return c.json({
    status: "success",
    timestamp: new Date().toISOString(),
    data: { city: "Austin", temperature: "78°F", condition: "Sunny" }
  });
});

serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`[API Server] Running on http://localhost:${info.port}`);
});

export default app;