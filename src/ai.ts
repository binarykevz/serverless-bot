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

const IMAGE_TIMEOUT_MS = 15_000;
const GEMINI_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES_FOR_VISION = 4_000_000; // 4MB safety limit for Workers

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
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function extractUrlFromRecord(record: any): string | null {
  if (!record || typeof record !== "object") return null;

  const knownKeys = [
    "url", "image_url", "imageUrl", "image", "src", "file", "file_url",
    "fileUrl", "link", "photo", "photo_url", "photoUrl", "download_url",
    "downloadUrl", "original", "large", "regular", "medium", "small", "thumb", "thumbnail"
  ];

  for (const key of knownKeys) {
    if (isHttpUrl(record[key])) return record[key];
  }

  if (record.urls && typeof record.urls === "object") {
    for (const key of ["raw", "full", "regular", "medium", "small", "thumb"]) {
      if (isHttpUrl(record.urls[key])) return record.urls[key];
    }
  }

  return null;
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
    const direct = extractUrlFromRecord(payload);
    if (direct) return direct;

    for (const value of Object.values(payload)) {
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
  } catch {
    return null;
  }
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

  async fetchRandomImage(): Promise<RandomImageResult | null> {
    // 1. Try Custom API
    try {
      if (this.imageApiUrl) {
        const apiRes = await fetchWithTimeout(this.imageApiUrl, { headers: { "Accept": "application/json, image/*" } }, IMAGE_TIMEOUT_MS);
        if (apiRes.ok) {
          const contentType = apiRes.headers.get("content-type") || "";
          if (contentType.startsWith("image/")) {
            return { url: this.imageApiUrl, buffer: await apiRes.arrayBuffer(), mimeType: contentType };
          }
          const json = safeJsonParse(await apiRes.text());
          const imageUrl = findImageUrlInPayload(json);
          if (imageUrl) {
            const imgRes = await fetchWithTimeout(imageUrl, { redirect: "follow" }, IMAGE_TIMEOUT_MS);
            if (imgRes.ok) return { url: imageUrl, buffer: await imgRes.arrayBuffer(), mimeType: imgRes.headers.get("content-type") || "image/jpeg" };
          }
        }
      }
    } catch (e) {
      console.warn("[KevinAI] Custom API failed, using fallback.", e);
    }

    // 2. Guaranteed Fallback (Picsum)
    try {
      const fallbackUrl = "https://picsum.photos/800/600";
      const imgRes = await fetchWithTimeout(fallbackUrl, { redirect: "follow" }, IMAGE_TIMEOUT_MS);
      if (imgRes.ok) {
        return { url: imgRes.url || fallbackUrl, buffer: await imgRes.arrayBuffer(), mimeType: "image/jpeg" };
      }
    } catch (e) {
      console.error("[KevinAI] Fallback image failed.", e);
    }

    return null;
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
