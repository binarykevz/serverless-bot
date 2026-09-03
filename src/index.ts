import { Hono } from "hono";
import { handleUpdate } from "./handler";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;

  AI_ROUTER_API_KEY: string;
  AI_ROUTER_BASE_URL: string;
  AI_ROUTER_MODEL: string;

  IMAGE_API_URL: string;

  TURSO_DB_URL: string;
  TURSO_AUTH_TOKEN: string;

  VIP_USER_IDS: string;

  MEDIA_API: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.text("Kevin is running.");
});

app.get("/set-webhook", async (c) => {
  const url = new URL(c.req.url);
  const webhookUrl = `${url.origin}/webhook/${c.env.WEBHOOK_SECRET}`;

  const res = await fetch(
    `https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message"],
      }),
    }
  );

  const data = await res.json();
  return c.json(data);
});

app.post("/webhook/:secret", async (c) => {
  const secret = c.req.param("secret");

  if (secret !== c.env.WEBHOOK_SECRET) {
    return c.text("Unauthorized", 403);
  }

  try {
    const update = await c.req.json();
    c.executionCtx.waitUntil(handleUpdate(update, c.env));
    return c.text("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    return c.text("Error", 500);
  }
});

export default app;
