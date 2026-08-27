import { createClient } from "@libsql/client/web";

// Helper to convert ArrayBuffer to Base64 for Gemini
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class KevinAI {
  private geminiKey: string;
  private geminiModel: string;
  private imageApiUrl: string;
  private db: any;

  constructor(env: any) {
    this.geminiKey = env.GEMINI_API_KEY;
    this.geminiModel = env.GEMINI_MODEL;
    this.imageApiUrl = env.IMAGE_API_URL;
    
    this.db = createClient({
      url: env.TURSO_DB_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    });
  }

  // 1. Text Generation
  async generateText(prompt: string, history: any[] = []): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiKey}`;
    
    const contents = [
      ...history.map(h => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.content }]
      })),
      { role: "user", parts: [{ text: prompt }] }
    ];

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
    });

    const data: any = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I'm thinking too hard right now.";
  }

  // 2. Fetch Random Image from your Custom API
  async fetchRandomImage(): Promise<{ url: string; buffer: ArrayBuffer; mimeType: string } | null> {
    try {
      const res = await fetch(this.imageApiUrl);
      if (!res.ok) return null;
      
      const data: any = await res.json();
      let imageUrl: string | null = null;

      // Handle different possible JSON structures from your API
      if (Array.isArray(data)) {
        const first = data[0];
        imageUrl = typeof first === 'string' ? first : first?.url || first?.image_url || first?.src;
      } else if (data.images && Array.isArray(data.images)) {
        const first = data.images[0];
        imageUrl = typeof first === 'string' ? first : first?.url || first?.image_url || first?.src;
      } else if (data.url) {
        imageUrl = data.url;
      }

      if (!imageUrl) return null;

      // Fetch the actual image binary
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) return null;
      
      const buffer = await imgRes.arrayBuffer();
      const mimeType = imgRes.headers.get("content-type") || "image/jpeg";

      return { url: imageUrl, buffer, mimeType };
    } catch (err) {
      console.error("Failed to fetch random image:", err);
      return null;
    }
  }

  // 3. Pass Image to Gemini Vision for Description
  async describeImage(imageBuffer: ArrayBuffer, mimeType: string): Promise<string> {
    try {
      const base64Image = arrayBufferToBase64(imageBuffer);
      
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiKey}`;
      
      const prompt = "Look at this image and give a short, natural, conversational description or reaction. Keep it brief, like 1-2 sentences. Stay in your persona (Kevin). Do not say 'Here is an image'.";

      const payload = {
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Image
              }
            }
          ]
        }],
        generationConfig: {
          maxOutputTokens: 150,
          temperature: 0.8
        }
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data: any = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "Here's a pic for you 😭";
    } catch (err) {
      console.error("Gemini vision failed:", err);
      return "Here's something I found 😭";
    }
  }

  // 4. Database Helpers
  async getHistory(userId: string): Promise<any[]> {
    const res = await this.db.execute({
      sql: "SELECT role, content FROM conversations WHERE user_id = ? ORDER BY seq DESC LIMIT 10",
      args: [userId]
    });
    return res.rows.reverse();
  }

  async saveMessage(userId: string, role: string, content: string) {
    await this.db.execute({
      sql: "INSERT INTO conversations (id, user_id, role, content) VALUES (?, ?, ?, ?)",
      args: [crypto.randomUUID(), userId, role, content]
    });
  }
}
