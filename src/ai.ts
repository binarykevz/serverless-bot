import { createClient } from "@libsql/client/web";

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

  // 2. Image Generation (Using your Custom API)
  async generateImage(): Promise<string | null> {
    try {
      const res = await fetch(this.imageApiUrl);
      const data: any = await res.json();
      
      // Adapt this based on your API's actual response structure
      // Assuming it returns an array of objects or URLs
      let imageUrl = null;
      
      if (Array.isArray(data)) {
        imageUrl = data[0]?.url || data[0];
      } else if (data.images && Array.isArray(data.images)) {
        imageUrl = data.images[0]?.url || data.images[0];
      } else if (data.url) {
        imageUrl = data.url;
      }

      return imageUrl;
    } catch (err) {
      console.error("Image API failed:", err);
      return null;
    }
  }

  // 3. Database Helpers
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
  
  async initDb() {
    // Run schema creation here if needed, or assume it exists
    // For Workers, it's better to run migrations via a script locally or CI
  }
}
