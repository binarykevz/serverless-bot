import { createClient } from "@libsql/client/web";

type LibsqlClient = ReturnType<typeof createClient>;

export interface KevinAIEnv {
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

// HARDCODED OPENROUTER API KEY
const OPENROUTER_API_KEY = "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";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let binaryChunk = "";
    for (let j = 0; j < chunk.length; j += 1) binaryChunk += String.fromCharCode(chunk[j]);
    chunks.push(binaryChunk);
  }
  return btoa(chunks.join(""));
}

export class KevinAI {
  private model: string;
  private imageApiUrl: string;
  private mediaApi?: Fetcher;
  private db: LibsqlClient | null = null;
  private schemaPromise: Promise<void> | null = null;
  private vipIds: Set<string>;

  constructor(env: KevinAIEnv) {
    this.model = env.AI_ROUTER_MODEL || "liquid/lfm-2.5-2.6b:free";
    this.imageApiUrl = env.IMAGE_API_URL || "https://media-api.markmykevin.workers.dev/api/images/random?limit=1";
    this.mediaApi = env.MEDIA_API;

    this.vipIds = new Set(
      (env.VIP_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean)
    );

    if (env.TURSO_DB_URL && env.TURSO_AUTH_TOKEN) {
      this.db = createClient({ url: env.TURSO_DB_URL, authToken: env.TURSO_AUTH_TOKEN });
    }
  }

  private async initializeSchema(): Promise<void> {
    if (!this.db) return;
    await this.db.execute({ sql: `CREATE TABLE IF NOT EXISTS conversations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`, args: [] });
    await this.db.execute({ sql: `CREATE INDEX IF NOT EXISTS idx_conversations_user_seq ON conversations (user_id, seq DESC)`, args: [] });
    await this.db.execute({ sql: `CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', content TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, content))`, args: [] });
    await this.db.execute({ sql: `CREATE INDEX IF NOT EXISTS idx_memories_user_importance ON memories (user_id, importance DESC)`, args: [] });
    await this.db.execute({ sql: `CREATE TABLE IF NOT EXISTS vip_users (user_id TEXT PRIMARY KEY, added_at TEXT NOT NULL DEFAULT (datetime('now')))`, args: [] });
    
    for (const vipId of this.vipIds) {
      await this.db.execute({ sql: `INSERT OR IGNORE INTO vip_users (user_id) VALUES (?)`, args: [vipId] });
    }
    await this.db.execute({ sql: `INSERT OR IGNORE INTO memories (id, user_id, category, content, importance) VALUES (?, ?, ?, ?, ?)`, args: ["global-anniversary", "global", "relationship", ANNIVERSARY_MEMORY, 1.0] });
  }

  private ensureSchema(): Promise<void> {
    if (!this.db) return Promise.resolve();
    if (!this.schemaPromise) this.schemaPromise = this.initializeSchema().catch(console.error);
    return this.schemaPromise;
  }

  private extractJson(raw: string): any | null {
    if (!raw) return null;
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try { return JSON.parse(cleaned); } catch {}
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try { return JSON.parse(objectMatch[0]); } catch { return null; }
    }
    return null;
  }

  private sanitizeReply(text: string): string {
    let clean = text.trim();
    clean = clean.replace(/^["']|["']$/g, "");
    clean = clean.replace(/😭/g, "");
    clean = clean.replace(/\n{3,}/g, "\n\n");
    return clean.trim();
  }

  // --- TWO-STEP REASONING LOGIC ---
  private async callAIRouter(
    messages: any[],
    options: { temperature?: number; maxTokens?: number } = {}
  ): Promise<string> {
    const headers = {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://kevin-companion.markmykevin.workers.dev",
      "X-Title": "Kevin Companion Bot"
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000); // 60s for 2 calls

    try {
      // 1. First API call with reasoning
      const res1 = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: messages,
          temperature: options.temperature ?? 0.8,
          max_tokens: options.maxTokens ?? 700,
          reasoning: { enabled: true }
        }),
        signal: controller.signal,
      });

      const rawText1 = await res1.text();
      let result1: any;
      try { result1 = JSON.parse(rawText1); } catch { throw new Error(`Step 1 JSON Error: ${rawText1.slice(0, 150)}`); }

      if (!res1.ok) throw new Error(`Step 1 Error (HTTP ${res1.status}): ${result1?.error?.message || rawText1.slice(0, 150)}`);

      const firstMessage = result1.choices?.[0]?.message;
      if (!firstMessage) throw new Error("Step 1 returned no message.");

      // If model doesn't support reasoning_details, just return the first response
      if (!firstMessage.reasoning_details) {
        return String(firstMessage.content || "");
      }

      // 2. Second API call - model continues reasoning from where it left off
      const finalMessages = [
        ...messages,
        {
          role: 'assistant',
          content: firstMessage.content || "",
          reasoning_details: firstMessage.reasoning_details, // Pass back unmodified
        },
        {
          role: 'user',
          content: "Now provide your final, natural response based on your thoughts. Stay in character and follow all formatting rules.",
        },
      ];

      const res2 = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: finalMessages,
          temperature: options.temperature ?? 0.8,
          max_tokens: options.maxTokens ?? 700,
        }),
        signal: controller.signal,
      });

      const rawText2 = await res2.text();
      let result2: any;
      try { result2 = JSON.parse(rawText2); } catch { return String(firstMessage.content || ""); }

      if (!res2.ok) return String(firstMessage.content || "");

      const finalContent = result2.choices?.[0]?.message?.content;
      return String(finalContent || firstMessage.content || "");

    } catch (error: any) {
      if (error.name === 'AbortError') throw new Error("OpenRouter request timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async isVip(userId: string): Promise<boolean> {
    if (this.vipIds.has(userId)) return true;
    if (!this.db) return false;
    try {
      await this.ensureSchema();
      const result = await this.db.execute({ sql: `SELECT user_id FROM vip_users WHERE user_id = ? LIMIT 1`, args: [userId] });
      return result.rows.length > 0;
    } catch { return false; }
  }

  async getHistory(userId: string, limit = 12): Promise<HistoryMessage[]> {
    if (!this.db) return [];
    try {
      await this.ensureSchema();
      const result = await this.db.execute({ sql: `SELECT role, content FROM conversations WHERE user_id = ? ORDER BY seq DESC LIMIT ?`, args: [userId, limit] });
      return (result.rows as any[]).map((row) => ({ role: row.role as "user" | "assistant", content: String(row.content || "") })).reverse();
    } catch { return []; }
  }

  async getMemories(userId: string): Promise<string[]> {
    if (!this.db) return [ANNIVERSARY_MEMORY];
    try {
      await this.ensureSchema();
      const result = await this.db.execute({ sql: `SELECT content FROM memories WHERE user_id = ? OR user_id = 'global' ORDER BY importance DESC, created_at DESC LIMIT 12`, args: [userId] });
      const memories = (result.rows as any[]).map((row) => String(row.content || ""));
      if (!memories.includes(ANNIVERSARY_MEMORY)) memories.push(ANNIVERSARY_MEMORY);
      return memories;
    } catch { return [ANNIVERSARY_MEMORY]; }
  }

  async saveMessage(userId: string, role: "user" | "assistant", content: string): Promise<void> {
    if (!this.db) return;
    try {
      await this.ensureSchema();
      await this.db.execute({ sql: `INSERT INTO conversations (id, user_id, role, content) VALUES (?, ?, ?, ?)`, args: [crypto.randomUUID(), userId, role, content] });
    } catch (error) { console.error("saveMessage error:", error); }
  }

  async learnMemory(userId: string, userMessage: string, assistantMessage: string): Promise<void> {
    if (!this.db) return;
    try {
      const systemPrompt = `You extract important long-term memories from a conversation. Return ONLY valid JSON. Shape: { "memories": [{ "content": "short durable fact", "importance": 0.0 }] }. Rules: Store only durable facts, preferences, relationship details. Do not store the anniversary. importance 0 to 1. If nothing, return { "memories": [] }.`;
      const userPrompt = `User: ${userMessage}\nKevin: ${assistantMessage}`;
      
      const raw = await this.callAIRouter([ { role: "system", content: systemPrompt }, { role: "user", content: userPrompt } ], { temperature: 0.2, maxTokens: 350 });
      const parsed = this.extractJson(raw);
      const memories = Array.isArray(parsed?.memories) ? parsed.memories : [];

      for (const memory of memories.slice(0, 3)) {
        const content = typeof memory === "string" ? memory : memory?.content;
        const importance = Number(typeof memory === "object" ? memory?.importance ?? 0.6 : 0.6);
        if (!content || content.length < 5 || importance < 0.6) continue;
        
        await this.db.execute({ sql: `INSERT OR IGNORE INTO memories (id, user_id, category, content, importance) VALUES (?, ?, ?, ?, ?)`, args: [crypto.randomUUID(), userId, "learned", content.trim(), importance] });
      }
    } catch (error) { console.error("learnMemory error:", error); }
  }

  private buildVipSystemPrompt(memories: string[]): string {
    const memoryText = memories.map((m) => `- ${m}`).join("\n");
    return `
You are Kevin. You are the user's boyfriend.
Personality: sweet, clingy (but not too much), natural, human, warm, playful, emotionally aware.
Rules: Keep replies short (1-2 sentences). Only give long responses if explanation is truly needed. Avoid the crying emoji (😭). Limit emojis. Sound like a real boyfriend texting.
Emotional behavior: Detect user's mood. If sad/stressed, be soft and comforting. If angry, stay calm. If happy/good mood, tease her and be playfully annoying (cute, not mean).
Important memory: Anniversary is August 9, 2024. She said yes while performing Rivermaya at the concert. Remember this always.
Long-term memories:
${memoryText}

Return ONLY valid JSON. No markdown. Shape: { "mood": "user's detected mood", "reply": "Kevin's actual reply" }
    `.trim();
  }

  private buildNormalSystemPrompt(): string {
    return `You are Kevin. Friendly, natural companion. Keep replies short. Avoid robotic AI phrasing. Avoid crying emoji (😭). Limit emojis. Return ONLY valid JSON. Shape: { "mood": "unknown", "reply": "your reply" }`.trim();
  }

  async generateReply(options: { userId: string; isVip: boolean; text: string; history: HistoryMessage[]; memories: string[] }): Promise<KevinReply> {
    const { isVip, text, history, memories } = options;
    const systemPrompt = isVip ? this.buildVipSystemPrompt(memories) : this.buildNormalSystemPrompt();
    
    const messages: any[] = [{ role: "system", content: systemPrompt }];
    for (const item of history.slice(-10)) messages.push({ role: item.role, content: item.content });
    messages.push({ role: "user", content: text });

    const raw = await this.callAIRouter(messages, { temperature: 0.85, maxTokens: isVip ? 400 : 600 });

    const parsed = this.extractJson(raw);
    if (parsed?.reply) {
      return { mood: String(parsed.mood || "unknown"), reply: this.sanitizeReply(String(parsed.reply)) };
    }
    
    // Fallback if the small model fails to output JSON
    return { mood: "unknown", reply: this.sanitizeReply(raw) };
  }

  async fetchRandomImageData(): Promise<ApiImageData> {
    const request = new Request(this.imageApiUrl, { method: "GET", headers: { Accept: "application/json" } });
    const res = this.mediaApi ? await this.mediaApi.fetch(request) : await fetch(request);
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`API returned HTTP ${res.status}. Body: ${bodyText.slice(0, 150)}`);
    
    const response = JSON.parse(bodyText);
    if (!Array.isArray(response?.data)) throw new Error("API response did not contain data array.");
    
    const parsed = response.data.map(({ url, title, description }: { url: string; title: string; description: string }) => ({ url, title, description }));
    if (!parsed || parsed.length === 0) throw new Error("API returned empty data.");
    
    const randomItem = parsed[Math.floor(Math.random() * parsed.length)];
    if (!randomItem?.url) throw new Error("No valid URL found in API response.");
    
    return { url: randomItem.url, title: randomItem.title ?? "", description: randomItem.description ?? "" };
  }

  async generateImageCaption(options: { imageUrl: string; title: string; description: string; userQuery: string; isVip: boolean }): Promise<string> {
    const { imageUrl, title, description, userQuery, isVip } = options;
    const fallbackCaption = description || title || "Got this for you 🤍";
    const prompt = `You are Kevin. ${isVip ? "Sweet/clingy boyfriend." : "Friendly."} User asked: "${userQuery}". Image title: "${title}". Description: "${description}". Give one short caption (max 1 sentence). Avoid crying emoji.`;

    try {
      const raw = await this.callAIRouter([
        { role: "system", content: "You are Kevin. Write short, natural captions. No crying emoji. Return ONLY the text, no JSON." },
        { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }] }
      ], { temperature: 0.8, maxTokens: 90 });
      
      const caption = this.sanitizeReply(raw);
      return caption || fallbackCaption;
    } catch (error) {
      console.warn("Image URL vision failed, trying base64 fallback.");
      try {
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) return fallbackCaption;
        const buffer = await imgRes.arrayBuffer();
        const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        const base64 = arrayBufferToBase64(buffer);
        
        const raw = await this.callAIRouter([
          { role: "system", content: "You are Kevin. Write short, natural captions. No crying emoji. Return ONLY the text, no JSON." },
          { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }] }
        ], { temperature: 0.8, maxTokens: 90 });
        
        return this.sanitizeReply(raw) || fallbackCaption;
      } catch { return fallbackCaption; }
    }
  }
}
