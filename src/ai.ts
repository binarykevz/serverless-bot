import { createClient } from "@libsql/client/web";

type LibsqlClient = ReturnType<typeof createClient>;

export interface KevinAIEnv {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  IMAGE_API_URL?: string;
  TURSO_DB_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ApiImageData {
  url: string;
  title?: string;
  description?: string;
}

export interface GeneratedImagePayload {
  imageUrl: string;
  caption: string;
}

const GEMINI_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES_FOR_VISION = 4_000_000; 

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
    this.imageApiUrl = env.IMAGE_API_URL || "https://media-api.markmykevin.workers.dev/api/images/random?limit=1";

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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
      
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          contents: [{ role: "user", parts: [{ text: prompt }] }], 
          generationConfig: { temperature: 0.7, maxOutputTokens: 512 } 
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      if (!res.ok) return "Hmm, medyo mabagal connection ko ngayon.";
      return parseGeminiText(await res.json()) || "Hmm.";
    } catch {
      return "Wait lang, may issue sa connection ko.";
    }
  }

  // Throws detailed errors so we can see exactly what is failing
  async fetchRandomImageData(): Promise<ApiImageData> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(this.imageApiUrl, { 
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`API returned HTTP ${res.status}`);
      }

      const text = await res.text();
      let json: any;
      
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`API returned invalid JSON: ${text.substring(0, 50)}...`);
      }

      if (json?.data && Array.isArray(json.data) && json.data.length > 0 && json.data[0]?.url) {
        return {
          url: json.data[0].url,
          title: json.data[0].title || "",
          description: json.data[0].description || ""
        };
      }

      throw new Error("No image URL found in API response");

    } catch (e: any) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') {
        throw new Error("API request timed out after 15s");
      }
      throw e;
    }
  }

  async describeImage(imageBuffer: ArrayBuffer, mimeType: string, customPrompt?: string): Promise<string> {
    if (!this.geminiKey || imageBuffer.byteLength > MAX_IMAGE_BYTES_FOR_VISION) {
      return "Got this for you 🤍";
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiKey}`;
      const prompt = customPrompt || "Look at this image. Give a very short, natural, and sweet reaction (1 sentence max). Act like a normal person. Do not use the crying emoji (😭). Do not sound like an AI.";
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: arrayBufferToBase64(imageBuffer) } }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 100 }
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);
      if (!res.ok) return "Got this for you 🤍";
      return parseGeminiText(await res.json()) || "Got this for you 🤍";
    } catch {
      return "Got this for you 🤍";
    }
  }

  async getRandomImageWithCaption(): Promise<GeneratedImagePayload> {
    const imageData = await this.fetchRandomImageData();

    let caption = imageData.description || imageData.title || "Got this for you 🤍";

    try {
      const imgRes = await fetch(imageData.url);
      if (imgRes.ok) {
        const buffer = await imgRes.arrayBuffer();
        const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        
        if (buffer.byteLength < MAX_IMAGE_BYTES_FOR_VISION) {
          const visionPrompt = `Look at this image. The original context was: "${imageData.title} - ${imageData.description}". Rewrite this into a very short, natural, sweet reaction (1 sentence max) as Kevin. Act like a normal person. Do not use the crying emoji (😭).`;
          const visionCaption = await this.describeImage(buffer, mimeType, visionPrompt);
          if (visionCaption && visionCaption !== "Got this for you 🤍") {
            caption = visionCaption;
          }
        }
      }
    } catch (e) {
      console.warn("Vision failed, using API description.");
    }

    return { imageUrl: imageData.url, caption };
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
