import { Hono } from "hono";
import { handleUpdate } from "./handler";
import { setWebhook } from "./telegram";

const app = new Hono<{
  Bindings: {
    TELEGRAM_BOT_TOKEN: string;
    GEMINI_API_KEY: string;
    TURSO_DB_URL: string;
    TURSO_AUTH_TOKEN: string;
    WEBHOOK_SECRET: string;
    GEMINI_MODEL: string;
    IMAGE_API_URL: string;
  };
}>();

// Health check
app.get("/", (c) => c.text("Kevin is online."));

// Set webhook (run this once manually or via cron)
app.get("/set-webhook", async (c) => {
  const url = new URL(c.req.url);
  const baseUrl = url.origin;
  const secret = c.env.WEBHOOK_SECRET;
  
  const result = await setWebhook(c.env.TELEGRAM_BOT_TOKEN, `${baseUrl}/webhook/${secret}`);
  return c.json(result);
});

// Telegram Webhook Endpoint
app.post("/webhook/:secret", async (c) => {
  const secret = c.req.param("secret");
  
  // Security check
  if (secret !== c.env.WEBHOOK_SECRET) {
    return c.text("Unauthorized", 403);
  }

  try {
    const update = await c.req.json();
    // Run handler in background (waitUntil) to respond to Telegram quickly
    c.executionCtx.waitUntil(handleUpdate(update, c.env));
    return c.text("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return c.text("Error", 500);
  }
});

export default app;
