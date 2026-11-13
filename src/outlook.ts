export interface OutlookMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { address?: string } };
  body?: { contentType?: string; content?: string };
}

interface TokenResponse {
  access_token: string;
}

interface MessagesPage {
  value: OutlookMessage[];
  "@odata.nextLink"?: string;
}

const GRAPH = "https://graph.microsoft.com/v1.0";
// Son N günde gelen tüm mailleri sayfalarken üst sınır: beklenmedik bir
// durumda (ör. çok kalabalık bir kutu) sonsuz sayfalamaya girmeyelim.
const MAX_PAGES = 20;

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

/// Graph ara sıra 429 / 5xx döner (ör. 502 UnknownError, 503, 504). Bunlar
/// isteğin kendisinden değil sunucu tarafından kaynaklanır; birkaç kez
/// artan beklemeyle tekrar deniyoruz. 4xx (429 hariç) hemen hata verir.
async function graphGet<T>(url: string, accessToken: string, attempts = 3): Promise<T> {
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.ok) return (await res.json()) as T;

    lastError = `${res.status} ${await res.text()}`;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || i === attempts - 1) break;
    await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
  }
  throw new Error(`Outlook mesajları alınamadı: ${lastError}`);
}

/// Gönderen ve konu eşleşmesini Graph yerine burada yapıyoruz: Graph'ta
/// `contains(subject, …)` + `$count` + `ConsistencyLevel: eventual`
/// ("advanced query") kişisel Outlook.com kutularında yavaş/güvenilmez;
/// 12 Kasım 2026'dan itibaren her çağrıda ~20 sn sonra 502 UnknownError
/// dönmeye başladı. Yalnızca tarihe göre filtrelemek basit ve hızlı bir
/// sorgu; birkaç günlük mailin konu/gönderen alanlarını süzmek ucuz.
export function matchesSenderAndSubject(
  message: OutlookMessage,
  fromAddress: string,
  subjectContains: string,
): boolean {
  const from = message.from?.emailAddress?.address?.toLowerCase();
  const subject = message.subject?.toLocaleLowerCase("tr-TR") ?? "";
  return (
    from === fromAddress.toLowerCase() &&
    subject.includes(subjectContains.toLocaleLowerCase("tr-TR"))
  );
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
  // $orderby'deki alan $filter'da da (ve ilk sırada) geçmeli, yoksa Graph
  // "InefficientFilter" hatası verir.
  let url: string | undefined =
    `${GRAPH}/me/messages` +
    `?$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}` +
    `&$orderby=receivedDateTime desc&$top=50&$select=id,subject,from,body`;

  const matches: OutlookMessage[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const data: MessagesPage = await graphGet<MessagesPage>(url, accessToken);
    for (const message of data.value ?? []) {
      if (matchesSenderAndSubject(message, fromAddress, subjectContains)) {
        matches.push(message);
      }
    }
    url = data["@odata.nextLink"];
  }

  return matches;
}

export function extractOutlookHtmlBody(message: OutlookMessage): string | null {
  return message.body?.content ?? null;
}
