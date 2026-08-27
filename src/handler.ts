import { sendMessage, sendPhoto, sendChatAction } from "./telegram";
import { KevinAI } from "./ai";

const VIP_USERS = new Set(["123456789", "987654321"]); 

export async function handleUpdate(update: any, env: any) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text || "";
  const isVip = VIP_USERS.has(userId);

  const ai = new KevinAI(env);
  
  await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");

  const isImageRequest = /(generate|create|show|send|pic|picture|photo|image|random)/i.test(text) && 
                         /(pic|picture|photo|image|random|selfie|wallpaper|draw)/i.test(text);

  if (isImageRequest) {
    await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, "upload_photo");

    const imageData = await ai.getRandomImageWithCaption();
    
    if (imageData) {
      await sendPhoto(env.TELEGRAM_BOT_TOKEN, chatId, imageData.imageUrl, imageData.caption);
      await ai.saveMessage(userId, "user", text);
      await ai.saveMessage(userId, "assistant", `[sent image: ${imageData.caption}]`);
      return;
    } else {
      // This should almost never happen now due to the fallback, but just in case:
      const fallback = isVip ? "Wait lang, I couldn't find a good picture right now. Try again later?" : "Sorry, couldn't fetch an image right now.";
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, fallback);
      return;
    }
  }

  const history = await ai.getHistory(userId);
  
  // NEW PERSONALITY PROMPT: Normal, grounded, short, sweet, no exaggerated clinginess, limit emojis
  const systemPrompt = isVip 
    ? "You are Kevin. You are talking to your partner. Act like a normal, grounded person. Do not be overly exaggerated, clingy, or dramatic. Keep your responses short, sweet, and impactful. Only write long paragraphs if a detailed explanation is absolutely necessary. Limit your use of emojis, and avoid using the crying emoji (😭). Be natural and warm." 
    : "You are Kevin. A friendly, normal person. Keep responses short, sweet, and natural. Avoid robotic AI phrases. Only explain in detail if strictly necessary. Limit emoji usage.";

  const historyText = history.map(h => `${h.role}: ${h.content}`).join("\n");
  const finalPrompt = `${systemPrompt}\n\nHistory:\n${historyText}\n\nUser: ${text}`;

  const reply = await ai.generateText(finalPrompt);

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);

  await ai.saveMessage(userId, "user", text);
  await ai.saveMessage(userId, "assistant", reply);
}
