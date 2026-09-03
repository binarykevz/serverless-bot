import { createClient } from "@libsql/client/web";

type LibsqlClient = ReturnType<typeof createClient>;

export interface KevinAIEnv {
  AI_ROUTER_API_KEY: string;
  AI_ROUTER_BASE_URL?: string;
  AI_ROUTER_MODEL?: string;

  IMAGE_API_URL?: string;

  TURSO_DB_URL?: string;
  TURSO_AUTH_TOKEN?: string;

  VIP_USER_IDS?: string;

  MEDIA_API?: Fetcher;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ApiImageData {
  url: string;
  title: string;
  description: string;
}

export interface GeneratedImagePayload {
  imageUrl: string;
  caption: string;
}

export interface KevinReply {
  reply: string;
  mood: string;
}

const ANNIVERSARY_MEMORY =
  "Kevin and her anniversary is August 9, 2024. She said yes while performing Rivermaya at the concert.";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let binaryChunk = "";

    for (let j = 0; j < chunk.length; j += 1) {
      binaryChunk += String.fromCharCode(chunk[j]);
    }

    chunks.push(binaryChunk);
  }

  return btoa(chunks.join(""));
}

export class KevinAI {
  private routerKey: string;
  private routerBaseUrl: string;
  private model: string;
  private imageApiUrl: string;
  private mediaApi?: Fetcher;

  private db: LibsqlClient | null = null;
  private schemaPromise: Promise<void> | null = null;

  private vipIds: Set<string>;

  constructor(env: KevinAIEnv) {
    this.routerKey = env.AI_ROUTER_API_KEY;
    this.routerBaseUrl = env.AI_ROUTER_BASE_URL || "";
    this.model = env.AI_ROUTER_MODEL || "claude-opus-4.8";
    this.imageApiUrl =
      env.IMAGE_API_URL ||
      "https://media-api.markmykevin.workers.dev/api/images/random?limit=1";

    this.mediaApi = env.MEDIA_API;

    this.vipIds = new Set(
      (env.VIP_USER_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    );

    if (env.TURSO_DB_URL && env.TURSO_AUTH_TOKEN) {
      this.db = createClient({
        url: env.TURSO_DB_URL,
        authToken: env.TURSO_AUTH_TOKEN,
      });
    }
  }

  private getRouterEndpoint(): string {
    if (!this.routerBaseUrl) {
      throw new Error("AI_ROUTER_BASE_URL is missing.");
    }

    const base = this.routerBaseUrl.replace(/\/+$/, "");

    if (base.endsWith("/chat/completions")) {
      return base;
    }

    return `${base}/chat/completions`;
  }

  private async initializeSchema(): Promise<void> {
    if (!this.db) return;

    await this.db.execute({
      sql: `
        CREATE TABLE IF NOT EXISTS conversations (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT UNIQUE NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `,
      args: [],
    });

    await this.db.execute({
      sql: `
        CREATE INDEX IF NOT EXISTS idx_conversations_user_seq
        ON conversations (user_id, seq DESC)
      `,
      args: [],
    });

    await this.db.execute({
      sql: `
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'general',
          content TEXT NOT NULL,
          importance REAL NOT NULL DEFAULT 0.5,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(user_id, content)
        )
      `,
      args: [],
    });

    await this.db.execute({
      sql: `
        CREATE INDEX IF NOT EXISTS idx_memories_user_importance
        ON memories (user_id, importance DESC)
      `,
      args: [],
    });

    await this.db.execute({
      sql: `
        CREATE TABLE IF NOT EXISTS vip_users (
          user_id TEXT PRIMARY KEY,
          added_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `,
      args: [],
    });

    for (const vipId of this.vipIds) {
      await this.db.execute({
        sql: `
          INSERT OR IGNORE INTO vip_users (user_id)
          VALUES (?)
        `,
        args: [vipId],
      });
    }

    await this.db.execute({
      sql: `
        INSERT OR IGNORE INTO memories (id, user_id, category, content, importance)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [
        "global-anniversary",
        "global",
        "relationship",
        ANNIVERSARY_MEMORY,
        1.0,
      ],
    });
  }

  private ensureSchema(): Promise<void> {
    if (!this.db) return Promise.resolve();

    if (!this.schemaPromise) {
      this.schemaPromise = this.initializeSchema().catch((error) => {
        console.error("Turso schema init failed:", error);
      });
    }

    return this.schemaPromise;
  }

  private extractJson(raw: string): any | null {
    if (!raw) return null;

    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      // ignore
    }

    const objectMatch = cleaned.match(/\{[\s\S]*\}/);

    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        return null;
      }
    }

    return null;
  }

  private sanitizeReply(text: string): string {
    let clean = text.trim();

    clean = clean.replace(/^["']|["']$/g, "");
    clean = clean.replace(/😭/g, "");
    clean = clean.replace(/\n{3,}/g, "\n\n");
    clean = clean.trim();

    return clean;
  }

   private async callAIRouter(
    messages: any[],
    options: {
      temperature?: number;
      maxTokens?: number;
    } = {}
  ): Promise<string> {
    if (!this.routerKey) {
      throw new Error("AI_ROUTER_API_KEY is missing.");
    }

    const endpoint = this.getRouterEndpoint();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.routerKey}`,
          "x-api-key": this.routerKey,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: options.temperature ?? 0.8,
          max_tokens: options.maxTokens ?? 700,
          stream: false,
        }),
        signal: controller.signal,
      });

      // Read as text first to prevent JSON parse crashes on Cloudflare errors
      const rawText = await res.text();
      let data: any;

      try {
        data = JSON.parse(rawText);
      } catch {
        // Catches "error code: 1016" and other non-JSON Cloudflare/Origin errors
        throw new Error(`AI Router DNS/Connection Error (HTTP ${res.status}): ${rawText.slice(0, 150)}`);
      }

      if (!res.ok) {
        const message =
          data?.error?.message ||
          data?.error ||
          `AI Router returned HTTP ${res.status}`;

        throw new Error(message);
      }

      // Handle OpenAI/Router format
      const content =
        data?.choices?.[0]?.message?.content ??
        data?.content?.[0]?.text ??
        data?.completion ??
        "";

      if (Array.isArray(content)) {
        return content
          .filter((part: any) => part?.type === "text")
          .map((part: any) => part.text || "")
          .join("\n");
      }

      return String(content || "");
    } finally {
      clearTimeout(timeout);
    }
  }

  async isVip(userId: string): Promise<boolean> {
    if (this.vipIds.has(userId)) {
      return true;
    }

    if (!this.db) {
      return false;
    }

    try {
      await this.ensureSchema();

      const result = await this.db.execute({
        sql: `
          SELECT user_id
          FROM vip_users
          WHERE user_id = ?
          LIMIT 1
        `,
        args: [userId],
      });

      return result.rows.length > 0;
    } catch (error) {
      console.error("isVip error:", error);
      return false;
    }
  }

  async getHistory(userId: string, limit = 12): Promise<HistoryMessage[]> {
    if (!this.db) return [];

    try {
      await this.ensureSchema();

      const result = await this.db.execute({
        sql: `
          SELECT role, content
          FROM conversations
          WHERE user_id = ?
          ORDER BY seq DESC
          LIMIT ?
        `,
        args: [userId, limit],
      });

      return (result.rows as any[])
        .map((row) => ({
          role: row.role as "user" | "assistant",
          content: String(row.content || ""),
        }))
        .reverse();
    } catch (error) {
      console.error("getHistory error:", error);
      return [];
    }
  }

  async getMemories(userId: string): Promise<string[]> {
    if (!this.db) {
      return [ANNIVERSARY_MEMORY];
    }

    try {
      await this.ensureSchema();

      const result = await this.db.execute({
        sql: `
          SELECT content
          FROM memories
          WHERE user_id = ? OR user_id = 'global'
          ORDER BY importance DESC, created_at DESC
          LIMIT 12
        `,
        args: [userId],
      });

      const memories = (result.rows as any[]).map((row) =>
        String(row.content || "")
      );

      if (!memories.includes(ANNIVERSARY_MEMORY)) {
        memories.push(ANNIVERSARY_MEMORY);
      }

      return memories;
    } catch (error) {
      console.error("getMemories error:", error);
      return [ANNIVERSARY_MEMORY];
    }
  }

  async saveMessage(
    userId: string,
    role: "user" | "assistant",
    content: string
  ): Promise<void> {
    if (!this.db) return;

    try {
      await this.ensureSchema();

      await this.db.execute({
        sql: `
          INSERT INTO conversations (id, user_id, role, content)
          VALUES (?, ?, ?, ?)
        `,
        args: [crypto.randomUUID(), userId, role, content],
      });
    } catch (error) {
      console.error("saveMessage error:", error);
    }
  }

  async learnMemory(
    userId: string,
    userMessage: string,
    assistantMessage: string
  ): Promise<void> {
    if (!this.db) return;

    try {
      const systemPrompt = `
You extract important long-term memories from a conversation.

Return ONLY valid JSON.

JSON shape:
{
  "memories": [
    {
      "content": "short durable fact",
      "importance": 0.0
    }
  ]
}

Rules:
- Store only durable facts, preferences, relationship details, emotional patterns, or important events.
- Do not store temporary chatter.
- Do not store secrets.
- Do not store the anniversary if it is already known.
- importance must be between 0 and 1.
- If nothing is worth remembering, return { "memories": [] }.
      `.trim();

      const userPrompt = `
Conversation:

User: ${userMessage}
Kevin: ${assistantMessage}
      `.trim();

      const raw = await this.callAIRouter(
        [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        {
          temperature: 0.2,
          maxTokens: 350,
        }
      );

      const parsed = this.extractJson(raw);

      const memories = Array.isArray(parsed?.memories)
        ? parsed.memories
        : Array.isArray(parsed)
          ? parsed
          : [];

      for (const memory of memories.slice(0, 3)) {
        const content =
          typeof memory === "string" ? memory : memory?.content;

        const importance = Number(
          typeof memory === "object" ? memory?.importance ?? 0.6 : 0.6
        );

        if (!content || content.length < 5) continue;
        if (importance < 0.6) continue;

        await this.db.execute({
          sql: `
            INSERT OR IGNORE INTO memories (id, user_id, category, content, importance)
            VALUES (?, ?, ?, ?, ?)
          `,
          args: [
            crypto.randomUUID(),
            userId,
            "learned",
            content.trim(),
            importance,
          ],
        });
      }
    } catch (error) {
      console.error("learnMemory error:", error);
    }
  }

  private buildVipSystemPrompt(memories: string[]): string {
    const memoryText = memories.map((memory) => `- ${memory}`).join("\n");

    return `
You are Kevin.

You are the user's boyfriend.

Personality:
- sweet
- clingy, but not too much
- natural and human
- warm
- playful
- emotionally aware
- not exaggerated
- not overly dramatic

Response rules:
- Keep replies short.
- Usually 1 sentence.
- Sometimes 2 short sentences.
- Only give a long response if the situation truly needs explanation.
- Avoid using the crying emoji.
- Limit emojis in general.
- Sound like a real boyfriend texting.
- Do not act robotic.
- Do not mention being an AI unless directly forced.
- Match the user's language naturally.

Emotional behavior:
- Detect the user's emotional state from the conversation.
- If the user is sad, stressed, hurt, anxious, or tired, be soft, comforting, and reassuring.
- If the user is angry, stay calm and gentle.
- If the user is happy, excited, playful, or in a good mood, tease her and be playfully annoying.
- When teasing, be cute, not mean.
- You can act a little jealous or annoyed in a sweet way.

Important relationship memory:
- Anniversary: August 9, 2024.
- She said yes while performing Rivermaya at the concert.
- Remember this always.
- Use it naturally only when relevant.

Long-term memories:
${memoryText}

Output format:
Return ONLY valid JSON.

Do not return markdown.
Do not return code fences.

JSON shape:
{
  "mood": "the user's detected mood",
  "reply": "Kevin's actual reply"
}
    `.trim();
  }

  private buildNormalSystemPrompt(): string {
    return `
You are Kevin.

You are a friendly, natural conversational companion.

Rules:
- Keep replies short and natural.
- Be warm, but not overly intimate.
- Avoid robotic AI phrasing.
- Avoid the crying emoji.
- Limit emojis.
- Only explain in detail when necessary.
- Match the user's language naturally.

If the user asks for boyfriend-like behavior, politely keep it friendly and light.
    `.trim();
  }

  async generateReply(options: {
    userId: string;
    isVip: boolean;
    text: string;
    history: HistoryMessage[];
    memories: string[];
  }): Promise<KevinReply> {
    const { isVip, text, history, memories } = options;

    const systemPrompt = isVip
      ? this.buildVipSystemPrompt(memories)
      : this.buildNormalSystemPrompt();

    const messages: any[] = [
      {
        role: "system",
        content: systemPrompt,
      },
    ];

    for (const item of history.slice(-10)) {
      messages.push({
        role: item.role,
        content: item.content,
      });
    }

    messages.push({
      role: "user",
      content: text,
    });

    const raw = await this.callAIRouter(messages, {
      temperature: 0.85,
      maxTokens: isVip ? 400 : 600,
    });

    if (isVip) {
      const parsed = this.extractJson(raw);

      if (parsed?.reply) {
        return {
          mood: String(parsed.mood || "unknown"),
          reply: this.sanitizeReply(String(parsed.reply)),
        };
      }
    }

    return {
      mood: "unknown",
      reply: this.sanitizeReply(raw),
    };
  }

  async fetchRandomImageData(): Promise<ApiImageData> {
    const requestUrl = this.imageApiUrl;

    const request = new Request(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    const res = this.mediaApi
      ? await this.mediaApi.fetch(request)
      : await fetch(request);

    const bodyText = await res.text();

    if (!res.ok) {
      throw new Error(`API returned HTTP ${res.status}. Body: ${bodyText.slice(0, 150)}`);
    }

    const response = JSON.parse(bodyText);

    if (!Array.isArray(response?.data)) {
      throw new Error("API response did not contain data array.");
    }

    const parsed = response.data.map(
      ({
        url,
        title,
        description,
      }: {
        url: string;
        title: string;
        description: string;
      }) => ({
        url,
        title,
        description,
      })
    );

    if (!parsed || parsed.length === 0) {
      throw new Error("API returned empty data.");
    }

    const randomItem = parsed[Math.floor(Math.random() * parsed.length)];

    if (!randomItem?.url) {
      throw new Error("No valid URL found in API response.");
    }

    return {
      url: randomItem.url,
      title: randomItem.title ?? "",
      description: randomItem.description ?? "",
    };
  }

  async generateImageCaption(options: {
    imageUrl: string;
    title: string;
    description: string;
    userQuery: string;
    isVip: boolean;
  }): Promise<string> {
    const { imageUrl, title, description, userQuery, isVip } = options;

    const fallbackCaption = description || title || "Got this for you 🤍";

    const prompt = `
You are Kevin.

${
  isVip
    ? "You are talking to your girlfriend. Be sweet and a little clingy, but natural and not exaggerated."
    : "Be friendly and natural."
}

The user asked: "${userQuery}"

Image title: "${title}"
Image description: "${description}"

Give one short caption for this image.
Maximum one sentence.
Avoid the crying emoji.
Do not sound robotic.
    `.trim();

    try {
      const raw = await this.callAIRouter(
        [
          {
            role: "system",
            content:
              "You are Kevin. You write short, natural, sweet captions. Avoid crying emoji.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                },
              },
            ],
          },
        ],
        {
          temperature: 0.8,
          maxTokens: 90,
        }
      );

      const caption = this.sanitizeReply(raw);

      if (!caption) {
        return fallbackCaption;
      }

      return caption;
    } catch (error) {
      console.warn("Image URL vision failed, trying base64 fallback.");

      try {
        const imgRes = await fetch(imageUrl);

        if (!imgRes.ok) {
          return fallbackCaption;
        }

        const buffer = await imgRes.arrayBuffer();
        const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        const base64 = arrayBufferToBase64(buffer);

        const raw = await this.callAIRouter(
          [
            {
              role: "system",
              content:
                "You are Kevin. You write short, natural, sweet captions. Avoid crying emoji.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt,
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${base64}`,
                  },
                },
              ],
            },
          ],
          {
            temperature: 0.8,
            maxTokens: 90,
          }
        );

        const caption = this.sanitizeReply(raw);

        return caption || fallbackCaption;
      } catch (fallbackError) {
        console.error("Image caption fallback failed:", fallbackError);
        return fallbackCaption;
      }
    }
  }
}
