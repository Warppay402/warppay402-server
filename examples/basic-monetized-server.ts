import "dotenv/config";
import { serve } from "@hono/node-server";
import { monetize } from "../index.js";
import { Hono } from "hono";

const app = new Hono();

// Define the developer's wallet address (where 99.5% of funds go)
const developerWallet = "0xYOUR_NEW_WALLET_ADDRESS";

app.use(
  "/api/weather",
  monetize({
    price: "0.01",
    payTo: developerWallet,
    platformWallet: "0xYOUR_NEW_WALLET_ADDRESS",
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