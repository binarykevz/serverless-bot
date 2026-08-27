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

const IMAGE_TIMEOUT_MS = 20_000;
const GEMINI_TIMEOUT_MS = 30_000;
const MAX_IMAGE_DESCRIPTION_BYTES = 6_000_000;

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
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
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
  if (!record || typeof record !== "object") {
    return null;
  }

  const knownKeys = [
    "url",
    "image_url",
    "imageUrl",
    "image",
    "src",
    "file",
    "file_url",
    "fileUrl",
    "link",
    "photo",
    "photo_url",
    "photoUrl",
    "download_url",
    "downloadUrl",
    "original",
    "large",
    "regular",
    "medium",
    "small",
    "thumb",
    "thumbnail",
  ];

  for (const key of knownKeys) {
    const value = record[key];

    if (isHttpUrl(value)) {
      return value;
    }
  }

  if (record.urls && typeof record.urls === "object") {
    const urlCandidates = ["raw", "full", "regular", "medium", "small", "thumb"];

    for (const key of urlCandidates) {
      const value = record.urls[key];

      if (isHttpUrl(value)) {
        return value;
      }
    }
  }

  if (record.files && Array.isArray(record.files)) {
    for (const file of record.files) {
      const found = extractUrlFromRecord(file);

      if (found) {
        return found;
      }
    }
  }

  return null;
}

function findImageUrlInPayload(payload: unknown, depth = 0): string | null {
  if (depth > 6 || payload === null || payload === undefined) {
    return null;
  }

  if (typeof payload === "string") {
    return isHttpUrl(payload) ? payload : null;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findImageUrlInPayload(item, depth + 1);

      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof payload === "object") {
    const direct = extractUrlFromRecord(payload);

    if (direct) {
      return direct;
    }

    for (const value of Object.values(payload)) {
      const found = findImageUrlInPayload(value, depth + 1);

      if (found) {
        return found;
      }
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

    for (let j = 0; j < chunk.length; j += 1) {
      binaryChunk += String.fromCharCode(chunk[j]);
    }

    chunks.push(binaryChunk);
  }

  return btoa(chunks.join(""));
}

function parseGeminiText(data: any): string | null {
  try {
    const parts = data?.candidates?.[0]?.content?.parts ?? [];

    const text = parts
      .filter((part: any) => typeof part?.text === "string")
      .map((part: any) => part.text)
      .join("\n")
      .trim();

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
    this.geminiModel = env.GEMINI_MODEL || "gemini-2.0-flash";
    this.imageApiUrl = normalizeApiUrl(env.IMAGE_API_URL);

    if (env.TURSO_DB_URL && env.TURSO_AUTH_TOKEN) {
      this.db = createClient({
        url: env.TURSO_DB_URL,
        authToken: env.TURSO_AUTH_TOKEN,
      });
    } else {
      console.warn("[KevinAI] Turso is not configured. History will not be saved.");
    }
  }

  private async initializeSchema(): Promise<void> {
    if (!this.db) {
      return;
    }

    await this.db.execute({
      sql: `
        CREATE TABLE IF NOT EXISTS conversations (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT UNIQUE NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
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
  }

  private ensureSchema(): Promise<void> {
    if (!this.db) {
      return Promise.resolve();
    }

    if (!this.schemaPromise) {
      this.schemaPromise = this.initializeSchema().catch((error) => {
        console.error("[KevinAI] Failed to initialize Turso schema:", error);
      });
    }

    return this.schemaPromise;
  }

  async generateText(prompt: string): Promise<string> {
    if (!this.geminiKey) {
      console.error("[KevinAI] Missing GEMINI_API_KEY.");
      return "Wait lang, may problema sa Gemini key ko 😭";
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiKey}`;

      const payload = {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 1024,
        },
      };

      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        GEMINI_TIMEOUT_MS
      );

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[KevinAI] Gemini text error ${res.status}:`, errorText.slice(0, 500));
        return "Wait lang, parang nagloko Gemini saakin 😭";
      }

      const data: any = await res.json();
      const text = parseGeminiText(data);

      if (!text) {
        console.error("[KevinAI] Gemini returned empty text response:", JSON.stringify(data).slice(0, 500));
        return "Hmm, wala akong makuang sagot dun 😭";
      }

      return text;
    } catch (error: any) {
      console.error("[KevinAI] generateText failed:", error?.message || error);
      return "Wait lang, may issue ako sa Gemini connection ko 😭";
    }
  }

  async fetchRandomImage(): Promise<RandomImageResult | null> {
    try {
      if (!this.imageApiUrl) {
        console.error("[KevinAI] Missing IMAGE_API_URL.");
        return null;
      }

      console.log(`[KevinAI] Fetching random image API: ${this.imageApiUrl}`);

      const apiRes = await fetchWithTimeout(
        this.imageApiUrl,
        {
          headers: {
            Accept: "application/json, text/plain, image/*",
            "User-Agent": "KevinWorker/1.0",
          },
        },
        IMAGE_TIMEOUT_MS
      );

      if (!apiRes.ok) {
        console.error(`[KevinAI] Image API returned ${apiRes.status} ${apiRes.statusText}`);
        return null;
      }

      const apiContentType = (apiRes.headers.get("content-type") || "").split(";")[0]?.trim();

      // Case 1: API directly returns an image binary.
      if (apiContentType.startsWith("image/")) {
        const buffer = await apiRes.arrayBuffer();

        if (!buffer.byteLength) {
          console.error("[KevinAI] Image API returned empty image buffer.");
          return null;
        }

        return {
          url: this.imageApiUrl,
          buffer,
          mimeType: apiContentType || "image/jpeg",
        };
      }

      const text = await apiRes.text();

      console.log("[KevinAI] Image API raw response:", text.slice(0, 700));

      let imageUrl: string | null = null;

      // Case 2: API returns plain text URL.
      if (isHttpUrl(text.trim())) {
        imageUrl = text.trim();
      }

      // Case 3: API returns JSON.
      if (!imageUrl) {
        const json = safeJsonParse(text);

        if (json) {
          imageUrl = findImageUrlInPayload(json);
        }
      }

      // Case 4: API returns HTML or unexpected text containing a direct URL.
      if (!imageUrl) {
        const match = text.match(/https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>]*)?/i);

        if (match?.[0]) {
          imageUrl = match[0];
        }
      }

      if (!imageUrl) {
        console.error("[KevinAI] Could not extract image URL from API response.");
        return null;
      }

      console.log(`[KevinAI] Extracted image URL: ${imageUrl}`);

      const imageRes = await fetchWithTimeout(
        imageUrl,
        {
          headers: {
            Accept: "image/*,*/*",
            "User-Agent": "Mozilla/5.0 KevinWorker/1.0",
          },
        },
        IMAGE_TIMEOUT_MS
      );

      if (!imageRes.ok) {
        console.error(`[KevinAI] Failed to download image. Status: ${imageRes.status}`);
        return null;
      }

      const mimeType = (imageRes.headers.get("content-type") || "").split(";")[0]?.trim() || "image/jpeg";

      if (!mimeType.startsWith("image/")) {
        console.error(`[KevinAI] Downloaded URL did not return an image. Content-Type: ${mimeType}`);
        return null;
      }

      const buffer = await imageRes.arrayBuffer();

      if (!buffer.byteLength) {
        console.error("[KevinAI] Downloaded image buffer is empty.");
        return null;
      }

      console.log(
        `[KevinAI] Image downloaded successfully. Size: ${buffer.byteLength} bytes. Type: ${mimeType}`
      );

      return {
        url: imageUrl,
        buffer,
        mimeType,
      };
    } catch (error: any) {
      console.error("[KevinAI] fetchRandomImage failed:", error?.message || error);

      if (error?.name === "AbortError") {
        console.error("[KevinAI] Image request timed out.");
      }

      return null;
    }
  }

  async describeImage(imageBuffer: ArrayBuffer, mimeType: string): Promise<string> {
    try {
      if (!this.geminiKey) {
        return "Here you go 😭";
      }

      if (imageBuffer.byteLength > MAX_IMAGE_DESCRIPTION_BYTES) {
        console.warn("[KevinAI] Image too large for Gemini description. Sending fallback caption.");
        return "Here you go 😭";
      }

      const base64Image = arrayBufferToBase64(imageBuffer);

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiKey}`;

      const prompt = [
        "Look at this image.",
        "Give a short, natural, conversational reaction or description.",
        "Keep it brief, around 1 sentence only.",
        "Sound casual and human.",
        "Do not say 'Here is an image'.",
        "Do not mention that you are an AI.",
      ].join(" ");

      const payload = {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt,
              },
              {
                inlineData: {
                  mimeType,
                  data: base64Image,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 180,
        },
      };

      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        GEMINI_TIMEOUT_MS
      );

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[KevinAI] Gemini Vision error ${res.status}:`, errorText.slice(0, 500));
        return "Here you go 😭";
      }

      const data: any = await res.json();
      const caption = parseGeminiText(data);

      if (!caption) {
        console.error("[KevinAI] Gemini Vision returned empty caption.");
        return "Here you go 😭";
      }

      return caption;
    } catch (error: any) {
      console.error("[KevinAI] describeImage failed:", error?.message || error);
      return "Here you go 😭";
    }
  }

  async getRandomImageWithCaption(): Promise<GeneratedImagePayload | null> {
    const image = await this.fetchRandomImage();

    if (!image) {
      return null;
    }

    const caption = await this.describeImage(image.buffer, image.mimeType);

    return {
      imageUrl: image.url,
      caption,
    };
  }

  async getHistory(userId: string, limit = 12): Promise<HistoryMessage[]> {
    if (!this.db) {
      return [];
    }

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
          content: String(row.content ?? ""),
        }))
        .reverse();
    } catch (error: any) {
      console.error("[KevinAI] getHistory failed:", error?.message || error);
      return [];
    }
  }

  async saveMessage(
    userId: string,
    role: "user" | "assistant",
    content: string
  ): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      await this.ensureSchema();

      const id = crypto.randomUUID();

      await this.db.execute({
        sql: `
          INSERT INTO conversations (
            id,
            user_id,
            role,
            content
          ) VALUES (?, ?, ?, ?)
        `,
        args: [id, userId, role, content ?? ""],
      });
    } catch (error: any) {
      console.error("[KevinAI] saveMessage failed:", error?.message || error);
    }
  }
}
