interface OutlookMessage {
  id: string;
  body?: { contentType?: string; content?: string };
}

interface TokenResponse {
  access_token: string;
}

interface MessagesResponse {
  value: OutlookMessage[];
}

async function getAccessToken(
  clientId: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch(
    "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: "https://graph.microsoft.com/Mail.Read offline_access",
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Outlook token yenileme başarısız: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as TokenResponse;
  return data.access_token;
}

// Gmail'in aksine Microsoft Graph, mesaj gövdesini zaten çözülmüş UTF-8 HTML
// olarak "body.content" alanında döner; ayrıca bir MIME/base64 çözme gerekmez.
export async function fetchMatchingOutlookMessages(
  clientId: string,
  refreshToken: string,
  fromAddress: string,
  subjectContains: string,
  newerThanDays: number,
): Promise<OutlookMessage[]> {
  const accessToken = await getAccessToken(clientId, refreshToken);

  const since = new Date(Date.now() - newerThanDays * 24 * 60 * 60 * 1000).toISOString();
  const filter =
    `from/emailAddress/address eq '${fromAddress}' and ` +
    `contains(subject,'${subjectContains}') and ` +
    `receivedDateTime ge ${since}`;

  const url =
    `https://graph.microsoft.com/v1.0/me/messages` +
    `?$filter=${encodeURIComponent(filter)}&$top=50&$select=id,body&$count=true`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // Graph'ta "contains()" gibi gelişmiş filtreler bu header olmadan
      // 400 döner (advanced query capability gerektiriyor).
      ConsistencyLevel: "eventual",
    },
  });

  if (!res.ok) {
    throw new Error(`Outlook mesajları alınamadı: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as MessagesResponse;
  return data.value ?? [];
}

export function extractOutlookHtmlBody(message: OutlookMessage): string | null {
  return message.body?.content ?? null;
}
