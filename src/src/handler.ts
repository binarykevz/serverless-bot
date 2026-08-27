import { sendMessage, sendPhoto, sendChatAction } from "./telegram";
import { KevinAI } from "./ai";

// VIP List (Hardcoded for serverless simplicity, or fetch from DB)
const VIP_USERS = new Set(["123456789", "987654321"]); 

export async function handleUpdate(update: any, env: any) {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text;
  const isVip = VIP_USERS.has(userId);

  const ai = new KevinAI(env);
  
  // 1. Typing Indicator
  await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");

  // 2. Check for Image Intent
  // Simple keyword detection for the custom API
  if (/(generate|create|show|send).*(image|picture|photo|pic)/i.test(text)) {
    const imageUrl = await ai.generateImage();
    if (imageUrl) {
      await sendPhoto(env.TELEGRAM_BOT_TOKEN, chatId, imageUrl, "Here you go 😭");
      await ai.saveMessage(userId, "user", text);
      await ai.saveMessage(userId, "assistant", "[sent image]");
      return;
    }
  }

  // 3. Text Response
  const history = await ai.getHistory(userId);
  
  // Build System Prompt (Simplified for Worker)
  const systemPrompt = isVip 
    ? "You are Kevin. VIP boyfriend persona. Clingy, teasing, conyo. User is your love." 
    : "You are Kevin. Friendly AI assistant.";

  const finalPrompt = `${systemPrompt}\n\nHistory:\n${history.map(h => `${h.role}: ${h.content}`).join("\n")}\n\nUser: ${text}`;

  const reply = await ai.generateText(finalPrompt);

  // 4. Send Reply
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);

  // 5. Save to DB
  await ai.saveMessage(userId, "user", text);
  await ai.saveMessage(userId, "assistant", reply);
}
