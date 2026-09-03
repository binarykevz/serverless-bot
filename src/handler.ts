import { sendMessage, sendPhoto, sendChatAction } from "./telegram";
import { KevinAI } from "./ai";

function isImageRequest(text: string): boolean {
  const cleaned = text.trim();

  if (!cleaned) return false;

  const noun = /(pic|picture|photo|image|wallpaper|selfie)/i;
  const verb = /(send|show|give|share|post|generate|create|random)/i;

  if (noun.test(cleaned) && verb.test(cleaned)) {
    return true;
  }

  return /^(pic|picture|photo|image|random pic|random picture|random photo|random image)$/i.test(
    cleaned
  );
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

  if (isImageRequest(text)) {
    await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, "upload_photo");

    try {
      const imageData = await ai.fetchRandomImageData();

      const caption = await ai.generateImageCaption({
        imageUrl: imageData.url,
        title: imageData.title,
        description: imageData.description,
        userQuery: text,
        isVip,
      });

      const sent = await sendPhoto(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        imageData.imageUrl,
        caption
      );

      if (!sent?.ok) {
        throw new Error("Telegram sendPhoto failed.");
      }

      await ai.saveMessage(userId, "user", text);
      await ai.saveMessage(userId, "assistant", `[image] ${caption}`);

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
