const API_BASE = "https://api.telegram.org/bot";

export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string
) {
  try {
    const res = await fetch(`${API_BASE}${token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });

    return await res.json();
  } catch (error) {
    console.error("sendMessage error:", error);
    return null;
  }
}

export async function sendPhoto(
  token: string,
  chatId: number | string,
  photoUrl: string,
  caption?: string
) {
  try {
    const res = await fetch(`${API_BASE}${token}/sendPhoto`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption || "",
      }),
    });

    const data = await res.json();

    if (data.ok) {
      return data;
    }

    console.warn("sendPhoto URL failed, trying file upload fallback.");

    return await sendPhotoAsFile(token, chatId, photoUrl, caption);
  } catch (error) {
    console.error("sendPhoto error:", error);
    return null;
  }
}

async function sendPhotoAsFile(
  token: string,
  chatId: number | string,
  photoUrl: string,
  caption?: string
) {
  try {
    const imgRes = await fetch(photoUrl);

    if (!imgRes.ok) {
      throw new Error(`Failed to download image: ${imgRes.status}`);
    }

    const arrayBuffer = await imgRes.arrayBuffer();
    const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
    const blob = new Blob([arrayBuffer], { type: mimeType });

    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("photo", blob, "image.jpg");

    if (caption) {
      formData.append("caption", caption);
    }

    const uploadRes = await fetch(`${API_BASE}${token}/sendPhoto`, {
      method: "POST",
      body: formData,
    });

    return await uploadRes.json();
  } catch (error) {
    console.error("sendPhotoAsFile error:", error);
    return null;
  }
}

export async function sendChatAction(
  token: string,
  chatId: number | string,
  action: string
) {
  try {
    await fetch(`${API_BASE}${token}/sendChatAction`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        action,
      }),
    });
  } catch (error) {
    console.error("sendChatAction error:", error);
  }
}
