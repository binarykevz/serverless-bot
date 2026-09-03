import { sendMessage, sendPhoto, sendChatAction } from "./telegram";
import { KevinAI } from "./ai";

// EXTREMELY BROAD IMAGE DETECTION
function isImageRequest(text: string): boolean {
  const cleaned = text.toLowerCase().trim();
  if (!cleaned) return false;

  // 1. Check for Action + Noun (e.g., "send pic", "padala ka photo", "picturan mo ako")
  const hasAction = /(send|show|give|share|post|generate|create|padala|ipadala|bigyan|picturan|gawa|bigay)/i.test(cleaned);
  const hasNoun = /(pic|picture|photo|image|wallpaper|selfie|pict|pics|pictures|photos|images)/i.test(cleaned);
  
  if (hasAction && hasNoun) return true;

  // 2. Check for direct noun requests (e.g., "random pic", "picture", "pic mo")
  if (/(^|\s)(pic|picture|photo|image|wallpaper|selfie|pict)(s)?(\s|$| mo| ko| nga)/i.test(cleaned)) return true;

  // 3. Exact short commands
  if (/^(pic|picture|photo|image|random pic|random picture|random photo|random image|picturan)$/i.test(cleaned)) return true;

  return false;
}

export async function handleUpdate(update: any, env: any) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text || "";
  if (!text) return;

  const ai = new KevinAI(env);
  const isVip = await ai.isVip(userId);

  await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");

  // IF USER ASKS FOR A PICTURE -> CALL IMAGE API
  if (isImageRequest(text)) {
    await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, "upload_photo");

    try {
      // 1. STRICTLY CALL THE IMAGE API
      const imageData = await ai.fetchRandomImageData();

      // 2. Generate caption using the text model (since liquid/lfm is text-only)
      const caption = await ai.generateImageCaption({
        imageUrl: imageData.url,
        title: imageData.title,
        description: imageData.description,
        userQuery: text,
        isVip,
      });

      // 3. Send the random image URL to Telegram
      const sent = await sendPhoto(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        imageData.url, // MUST BE .url
        caption
      );

      if (!sent?.ok) {
        throw new Error("Telegram sendPhoto failed.");
      }

      await ai.saveMessage(userId, "user", text);
      await ai.saveMessage(userId, "assistant", `[sent image: ${caption}]`);

      if (isVip) {
        await ai.learnMemory(userId, text, caption);
      }
    } catch (error: any) {
      console.error("Image request failed:", error?.message);

      const errorMessage = isVip
        ? "Aww, I couldn't get a picture right now 🥺 Try again?"
        : "Sorry, couldn't fetch an image right now.";

      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, errorMessage);
    }

    return;
  }

  // NORMAL TEXT CONVERSATION
  try {
    const history = await ai.getHistory(userId, isVip ? 18 : 10);
    const memories = await ai.getMemories(userId);

    const result = await ai.generateReply({
      userId,
      isVip,
      text,
      history,
      memories,
    });

    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, result.reply);

    await ai.saveMessage(userId, "user", text);
    await ai.saveMessage(userId, "assistant", result.reply);

    if (isVip) {
      await ai.learnMemory(userId, text, result.reply);
    }
  } catch (error: any) {
    console.error("Kevin reply failed:", error?.message);

    const errorMessage = isVip
      ? "Babe, my brain lagged for a second 🥺 Try me again?"
      : "Sorry, I had a connection issue.";

    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, errorMessage);
  }
}
