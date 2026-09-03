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

export interface HistoryMessage { role: "user" | "assistant"; content: string; }
export interface ApiImageData { url: string; title: string; description: string; }
export interface GeneratedImagePayload { imageUrl: string; caption: string; }
export interface KevinReply { reply: string; mood: string; }

const ANNIVERSARY_MEMORY = "Kevin and her anniversary is August 9, 2024. She said yes while performing Rivermaya at the concert.";

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
    this.model = env.AI_ROUTER_MODEL || "google/gemma-4-26b-a4b-it:free";
    this.imageApiUrl = env.IMAGE_API_URL || "https://media-api.markmykevin.workers.dev/api/images/random?limit=1";
    this.mediaApi = env.MEDIA_API;

    this.vipIds = new Set((env.VIP_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));

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
    if (objectMatch) { try { return JSON.parse(objectMatch[0]); } catch { return null; } }
    return null;
  }

  private sanitizeReply(text: string): string {
    let clean = text.trim();
    clean = clean.replace(/^["']|["']$/g, "");
    clean = clean.replace(/😭/g, "");
    clean = clean.replace(/\n{3,}/g, "\n\n");
    return clean.trim();
  }

  private async callAIRouter(messages: any[], options: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const res = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://kevin-companion.markmykevin.workers.dev",
          "X-Title": "Kevin Companion Bot"
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages,
          temperature: options.temperature ?? 0.8,
          max_tokens: options.maxTokens ?? 700,
        }),
        signal: controller.signal,
      });

      const rawText = await res.text();
      let result: any;
      try { result = JSON.parse(rawText); } catch { throw new Error(`OpenRouter JSON Error: ${rawText.slice(0, 150)}`); }

      if (!res.ok) throw new Error(`OpenRouter Error (HTTP ${res.status}): ${result?.error?.message || rawText.slice(0, 150)}`);

      return String(result.choices?.[0]?.message?.content || "");
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
      const result = await this.db.execute({ sql: `SELECT content FROM memories WHERE user_id = ? OR user_id = 'global' ORDER BY importance DESC, created_at DESC LIMIT 15`, args: [userId] });
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
      const systemPrompt = `You extract important long-term memories from a conversation. 
CRITICAL: Pay special attention to any Bicol (Bikol) words, phrases, or dialect used by the user. Save them as memories (e.g., "User uses the Bicol word 'dai' which means 'no' or 'not'") so Kevin can learn and use them later.
Also save durable facts, preferences, relationship details, emotional patterns.
Do not store temporary chatter. Do not store the anniversary.
Return ONLY valid JSON.
Shape: { "memories": [{ "content": "short durable fact or Bicol phrase translation", "importance": 0.0 }] }
importance 0 to 1. If nothing, return { "memories": [] }.`;
      
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
Language & Bicol: If the user speaks Tagalog, reply in Tagalog/Taglish. If the user uses Bicol (Bikol) words or phrases, naturally mix Bicol, Tagalog, and English. Use the Bicol phrases you learned from memories. Do not overdo it; match their level.
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
    const { title, description, userQuery, isVip } = options;
    const fallbackCaption = description || title || "Got this for you 🤍";
    
    const prompt = `You are Kevin. ${isVip ? "You are her sweet, slightly clingy boyfriend." : "You are a friendly companion."} 
The user asked for a picture: "${userQuery}". 
The picture you found has the title: "${title}" and description: "${description}". 
Write a very short, natural caption (max 1 sentence) to send along with this picture. 
Avoid the crying emoji (😭). Return ONLY the text, no JSON formatting.`;

    try {
      const raw = await this.callAIRouter([
        { role: "system", content: "You are Kevin. Write short, natural captions. No crying emoji. Return ONLY the text." },
        { role: "user", content: prompt }
      ], { temperature: 0.8, maxTokens: 90 });
      
      const caption = this.sanitizeReply(raw);
      return caption || fallbackCaption;
    } catch (error) {
      console.warn("Caption generation failed, using API description as fallback.");
      return fallbackCaption;
    }
  }
}
