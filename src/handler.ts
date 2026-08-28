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

    // Guaranteed to return a valid image payload now
    const imageData = await ai.getRandomImageWithCaption();
    
    await sendPhoto(env.TELEGRAM_BOT_TOKEN, chatId, imageData.imageUrl, imageData.caption);
    await ai.saveMessage(userId, "user", text);
    await ai.saveMessage(userId, "assistant", `[sent image: ${imageData.caption}]`);
    return;
  }

  const history = await ai.getHistory(userId);
  
  const systemPrompt = isVip 
    ? "You are Kevin. Act like a normal, grounded person talking to your partner. Do not be overly exaggerated, clingy, or dramatic. Keep responses short, sweet, and impactful. Only write long paragraphs if a detailed explanation is absolutely necessary. Limit your use of emojis, and strictly avoid using the crying emoji (😭). Be natural, warm, and concise." 
    : "You are Kevin. A friendly, normal person. Keep responses short, sweet, and natural. Avoid robotic AI phrases. Only explain in detail if strictly necessary. Limit emoji usage and never use the crying emoji (😭).";

  const historyText = history.map(h => `${h.role}: ${h.content}`).join("\n");
  const finalPrompt = `${systemPrompt}\n\nHistory:\n${historyText}\n\nUser: ${text}`;

  const reply = await ai.generateText(finalPrompt);

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);

  await ai.saveMessage(userId, "user", text);
  await ai.saveMessage(userId, "assistant", reply);
}
