import { sendMessage, sendPhoto, sendChatAction } from "./telegram";
import { KevinAI } from "./ai";

// VIP List (Hardcoded for serverless simplicity, or fetch from DB)
const VIP_USERS = new Set(["123456789", "987654321"]); 

export async function handleUpdate(update: any, env: any) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text || "";
  const isVip = VIP_USERS.has(userId);

  const ai = new KevinAI(env);
  
  // 1. Typing Indicator
  await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");

  // 2. Check for Image Intent
  const isImageRequest = /(generate|create|show|send|pic|picture|photo|image|random)/i.test(text) && 
                         /(pic|picture|photo|image|random|selfie|wallpaper|draw)/i.test(text);

  if (isImageRequest) {
    // Change indicator to uploading photo
    await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, "upload_photo");

    const imageData = await ai.fetchRandomImage();
    
    if (imageData) {
      // Pass to Gemini for description
      const description = await ai.describeImage(imageData.buffer, imageData.mimeType);
      
      // Send to Telegram using the URL (Telegram downloads it directly)
      await sendPhoto(env.TELEGRAM_BOT_TOKEN, chatId, imageData.url, description);
      
      await ai.saveMessage(userId, "user", text);
      await ai.saveMessage(userId, "assistant", `[sent image: ${description}]`);
      return;
    } else {
      const fallback = isVip 
        ? "Wait lang love, I couldn't find a good picture right now 😭 Try again later?" 
        : "Sorry, I couldn't fetch an image right now. Try again later.";
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, fallback);
      return;
    }
  }

  // 3. Text Response
  const history = await ai.getHistory(userId);
  
  // Build System Prompt (Simplified for Worker)
  const systemPrompt = isVip 
    ? "You are Kevin. VIP boyfriend persona. Clingy, teasing, conyo. User is your love. Keep responses relatively short and natural." 
    : "You are Kevin. Friendly AI assistant. Keep responses concise.";

  const finalPrompt = `${systemPrompt}\n\nHistory:\n${history.map(h => `${h.role}: ${h.content}`).join("\n")}\n\nUser: ${text}`;

  const reply = await ai.generateText(finalPrompt);

  // 4. Send Reply
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);

  // 5. Save to DB
  await ai.saveMessage(userId, "user", text);
  await ai.saveMessage(userId, "assistant", reply);
}
