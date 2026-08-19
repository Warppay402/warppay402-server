import { Hono } from "hono";
import { monetize, createMonetizedMCPTool } from "./index";

// ============================================================================
// 1. Test Web API Middleware
// ============================================================================
const app = new Hono();

app.use(
  "/api/weather",
  monetize({
    price: "0.05",
    payTo: "0x1111111111111111111111111111111111111111",
    platformFeeBps: 50
  })
);

app.get("/api/weather", (c) => {
  return c.json({ city: "Austin", temperature: "78F", condition: "Sunny" });
});

// ============================================================================
// 2. Test MCP Tool Decorator
// ============================================================================
const monetizedSearchTool = createMonetizedMCPTool(
  {
    name: "web_search",
    description: "Perform deep web searches for AI agents",
    inputSchema: { type: "object" },
    handler: async (args: { query: string }) => {
      return { status: "success", data: `Search results for: ${args.query}` };
    }
  },
  {
    price: "0.10",
    payTo: "0x1111111111111111111111111111111111111111",
    platformFeeBps: 50
  }
);

// ============================================================================
// 3. Execution Simulation
// ============================================================================
async function runLocalVerification() {
  console.log("==================================================");
  console.log("1. TESTING HTTP API MIDDLEWARE WITHOUT PAYMENT");
  console.log("==================================================");
  
  const unauthenticatedRes = await app.request("http://localhost/api/weather");
  console.log("HTTP Status Code:", unauthenticatedRes.status, "(Expected: 402)");
  console.log(
    "PAYMENT-REQUIRED Header:",
    unauthenticatedRes.headers.get("PAYMENT-REQUIRED") ? "RECEIVED ✓" : "MISSING ✗"
  );
  
  const challengeBody = await unauthenticatedRes.json();
  console.log("Challenge Payload:", JSON.stringify(challengeBody, null, 2));

  console.log("\n==================================================");
  console.log("2. TESTING MCP TOOL DECORATOR WITHOUT PAYMENT");
  console.log("==================================================");
  
  try {
    await monetizedSearchTool.handler({ query: "Base network x402" }, {});
  } catch (err: any) {
    console.log("Caught Expected MCP 402 Error ✓");
    console.log("MCP Error Payload:", JSON.parse(err.message));
  }
}

runLocalVerification();