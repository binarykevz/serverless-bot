import { createClient } from "@libsql/client/web";

type LibsqlClient = ReturnType<typeof createClient>;

export interface KevinAIEnv {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  IMAGE_API_URL: string;
  TURSO_DB_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RandomImageResult {
  url: string;
  buffer: ArrayBuffer;
  mimeType: string;
}

export interface GeneratedImagePayload {
  imageUrl: string;
  caption: string;
}

const IMAGE_TIMEOUT_MS = 20_000; // 20s timeout for slow APIs
const GEMINI_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES_FOR_VISION = 4_000_000; 

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function normalizeApiUrl(url: string): string {
  return (url || "").trim().replace(/([^:]\/)\/+/g, "$1");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = IMAGE_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function safeJsonParse(text: string): any | null {
  try { return JSON.parse(text); } catch { return null; }
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function findImageUrlInPayload(payload: unknown, depth = 0): string | null {
  if (depth > 6 || payload === null || payload === undefined) return null;
  if (typeof payload === "string") return isHttpUrl(payload) ? payload : null;

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findImageUrlInPayload(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof payload === "object") {
    const record = payload as Record<string, any>;
    const knownKeys = [
      "url", "image_url", "imageUrl", "image", "src", "file", "file_url",
      "link", "photo", "download_url", "original", "large", "regular", "medium", "small", "thumb"
    ];
    for (const key of knownKeys) {
      if (isHttpUrl(record[key])) return record[key];
    }
    
    if (record.urls && typeof record.urls === "object") {
      for (const key of ["raw", "full", "regular", "medium", "small", "thumb"]) {
        if (isHttpUrl(record.urls[key])) return record.urls[key];
      }
    }

    for (const value of Object.values(record)) {
      const found = findImageUrlInPayload(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

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

function parseGeminiText(data: any): string | null {
  try {
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((p: any) => typeof p?.text === "string").map((p: any) => p.text).join("\n").trim();
    return text || null;
  } catch { return null; }
}

export class KevinAI {
  private geminiKey: string;
  private geminiModel: string;
  private imageApiUrl: string;
  private db: LibsqlClient | null = null;
  private schemaPromise: Promise<void> | null = null;

  constructor(env: KevinAIEnv) {
    this.geminiKey = env.GEMINI_API_KEY;
    this.geminiModel = env.GEMINI_MODEL || "gemini-1.5-flash";
    this.imageApiUrl = normalizeApiUrl(env.IMAGE_API_URL);

    if (env.TURSO_DB_URL && env.TURSO_AUTH_TOKEN) {
      this.db = createClient({ url: env.TURSO_DB_URL, authToken: env.TURSO_AUTH_TOKEN });
    }
  }

  private async initializeSchema(): Promise<void> {
    if (!this.db) return;
    await this.db.execute({
      sql: `CREATE TABLE IF NOT EXISTS conversations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`, args: []
    });
    await this.db.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_conversations_user_seq ON conversations (user_id, seq DESC)`, args: []
    });
  }

  private ensureSchema(): Promise<void> {
    if (!this.db) return Promise.resolve();
    if (!this.schemaPromise) this.schemaPromise = this.initializeSchema().catch(console.error);
    return this.schemaPromise;
  }

  async generateText(prompt: string): Promise<string> {
    if (!this.geminiKey) return "Wait lang, may problema sa connection ko.";
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiKey}`;
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 512 } })
      }, GEMINI_TIMEOUT_MS);

      if (!res.ok) return "Hmm, medyo mabagal connection ko ngayon.";
      return parseGeminiText(await res.json()) || "Hmm.";
    } catch {
      return "Wait lang, may issue sa connection ko.";
    }
  }

  // STRICTLY USES YOUR PROVIDED API
  async fetchRandomImage(): Promise<RandomImageResult | null> {
    try {
      if (!this.imageApiUrl) {
        console.error("[KevinAI] IMAGE_API_URL is missing in env.");
        return null;
      }

      console.log(`[KevinAI] Fetching from strictly provided API: ${this.imageApiUrl}`);
      
      // Fetch JSON from your API using browser headers to avoid WAF blocks
      const apiRes = await fetchWithTimeout(this.imageApiUrl, { headers: BROWSER_HEADERS }, IMAGE_TIMEOUT_MS);
      
      if (!apiRes.ok) {
        console.error(`[KevinAI] API failed with status ${apiRes.status}`);
        return null;
      }

      const contentType = apiRes.headers.get("content-type") || "";
      let imageUrl: string | null = null;

      // If API returns raw image
      if (contentType.startsWith("image/")) {
        const buffer = await apiRes.arrayBuffer();
        return { url: this.imageApiUrl, buffer, mimeType: contentType };
      }

      // Parse JSON
      const text = await apiRes.text();
      console.log(`[KevinAI] API Response Preview: ${text.substring(0, 300)}`);
      
      const json = safeJsonParse(text);
      if (json) {
        imageUrl = findImageUrlInPayload(json);
      }

      if (!imageUrl) {
        // Fallback regex if JSON parser missed it
        const match = text.match(/https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>]*)?/i);
        if (match) imageUrl = match[0];
      }

      if (!imageUrl) {
        console.error("[KevinAI] Could not extract URL from API response.");
        return null;
      }

      console.log(`[KevinAI] Extracted Image URL: ${imageUrl}`);

      // Download the actual image
      const imgRes = await fetchWithTimeout(imageUrl, { headers: BROWSER_HEADERS, redirect: "follow" }, IMAGE_TIMEOUT_MS);
      if (!imgRes.ok) {
        console.error(`[KevinAI] Image download failed with status ${imgRes.status}`);
        return null;
      }

      const buffer = await imgRes.arrayBuffer();
      const mimeType = imgRes.headers.get("content-type") || "image/jpeg";

      return { url: imageUrl, buffer, mimeType };
    } catch (error: any) {
      console.error("[KevinAI] fetchRandomImage exception:", error.message || error);
      return null;
    }
  }

  async describeImage(imageBuffer: ArrayBuffer, mimeType: string): Promise<string> {
    if (!this.geminiKey || imageBuffer.byteLength > MAX_IMAGE_BYTES_FOR_VISION) {
      return "Got this for you 🤍";
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiKey}`;
      const prompt = "Look at this image. Give a very short, natural, and sweet reaction (1 sentence max). Act like a normal person. Do not use the crying emoji (😭). Do not sound like an AI.";
      
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: arrayBufferToBase64(imageBuffer) } }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 100 }
        })
      }, GEMINI_TIMEOUT_MS);

      if (!res.ok) return "Got this for you 🤍";
      return parseGeminiText(await res.json()) || "Got this for you 🤍";
    } catch {
      return "Got this for you 🤍";
    }
  }

  async getRandomImageWithCaption(): Promise<GeneratedImagePayload | null> {
    const image = await this.fetchRandomImage();
    if (!image) return null;
    const caption = await this.describeImage(image.buffer, image.mimeType);
    return { imageUrl: image.url, caption };
  }

  async getHistory(userId: string, limit = 10): Promise<HistoryMessage[]> {
    if (!this.db) return [];
    try {
      await this.ensureSchema();
      const result = await this.db.execute({ sql: "SELECT role, content FROM conversations WHERE user_id = ? ORDER BY seq DESC LIMIT ?", args: [userId, limit] });
      return (result.rows as any[]).map(r => ({ role: r.role, content: r.content })).reverse();
    } catch { return []; }
  }

  async saveMessage(userId: string, role: "user" | "assistant", content: string): Promise<void> {
    if (!this.db) return;
    try {
      await this.ensureSchema();
      await this.db.execute({ sql: "INSERT INTO conversations (id, user_id, role, content) VALUES (?, ?, ?, ?)", args: [crypto.randomUUID(), userId, role, content] });
    } catch {}
  }
}
