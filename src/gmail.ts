import { google, gmail_v1 } from "googleapis";

export function getGmailClient(): gmail_v1.Gmail {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

export async function fetchMatchingMessages(
  gmail: gmail_v1.Gmail,
  query: string,
): Promise<gmail_v1.Schema$Message[]> {
  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 50,
  });
  const ids = list.data.messages ?? [];

  const messages: gmail_v1.Schema$Message[] = [];
  for (const { id } of ids) {
    if (!id) continue;
    const full = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    messages.push(full.data);
  }
  return messages;
}

// Gmail API, format=full ile Content-Transfer-Encoding'i (quoted-printable vb.)
// zaten çözerek döner; body.data burada doğrudan kullanılabilir UTF-8 HTML'dir.
export function extractHtmlBody(
  payload?: gmail_v1.Schema$MessagePart,
): string | null {
  if (!payload) return null;
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const part of payload.parts ?? []) {
    const found = extractHtmlBody(part);
    if (found) return found;
  }
  return null;
}
