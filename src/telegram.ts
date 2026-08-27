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
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
    }),
  });
}

export async function sendPhoto(token: string, chatId: number | string, photoUrl: string, caption?: string) {
  return fetch(`${API_BASE}${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
    }),
  });
}

export async function sendChatAction(token: string, chatId: number | string, action: string) {
  return fetch(`${API_BASE}${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

export async function getFile(token: string, fileId: string) {
  const res = await fetch(`${API_BASE}${token}/getFile?file_id=${fileId}`);
  const data: any = await res.json();
  if (!data.ok) return null;
  return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
}
