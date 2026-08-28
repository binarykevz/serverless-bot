const API_BASE = "https://api.telegram.org/bot";

export async function setWebhook(token: string, url: string) {
  const res = await fetch(`${API_BASE}${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, allowed_updates: ["message"] }),
  });
  return res.json();
}

export async function sendMessage(token: string, chatId: number | string, text: string) {
  return fetch(`${API_BASE}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text }),
  });
}

export async function sendPhoto(token: string, chatId: number | string, photoUrl: string, caption?: string) {
  try {
    // Try sending via URL first (fastest)
    const res = await fetch(`${API_BASE}${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: caption }),
    });

    const data: any = await res.json();
    if (data.ok) return data; // Success!
    
    console.warn("[Telegram] URL send failed, downloading and uploading file instead...", data);
  } catch (e) {
    console.warn("[Telegram] URL send exception, downloading and uploading...", e);
  }

  // Fallback: Download image and upload via multipart/form-data (Guaranteed delivery)
  try {
    const imgRes = await fetch(photoUrl);
    if (!imgRes.ok) throw new Error("Failed to download image for upload");
    
    const blob = await imgRes.blob();
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("photo", blob, "image.jpg");
    if (caption) formData.append("caption", caption);

    const uploadRes = await fetch(`${API_BASE}${token}/sendPhoto`, {
      method: "POST",
      body: formData,
    });
    
    return await uploadRes.json();
  } catch (e) {
    console.error("[Telegram] File upload failed:", e);
    return { ok: false, error: e };
  }
}

export async function sendChatAction(token: string, chatId: number | string, action: string) {
  return fetch(`${API_BASE}${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}
