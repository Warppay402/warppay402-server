import "dotenv/config";
import { serve } from "@hono/node-server";
import { monetize } from "../index.js";
import { Hono } from "hono";

const app = new Hono();

// Define the developer's wallet address (where 99.5% of funds go)
const developerWallet = "0x2bd4e0ea72e21155ec41f8613eafd433193c4d8b";

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