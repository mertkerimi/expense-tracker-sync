import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface RawGmailMessage {
  id: string;
  html: string | null;
}

// Google, OAuth consent screen'i "Testing" modundayken verdiği refresh
// token'ları 7 günde bir otomatik geçersiz kılıyor — bu da GitHub Actions'ın
// haftada bir sessizce durmasına ve GitHub'ın sana "job failed" maili
// atmasına sebep oluyordu (bkz. git log). Bunun yerine düz IMAP + App
// Password kullanıyoruz: App Password, kullanıcı elle iptal etmediği sürece
// süresiz geçerli, bu yüzden bu sorunu kökten çözüyor. (Outlook tarafı hâlâ
// Microsoft Graph OAuth kullanıyor — Aylin'in refresh token'ı bu tür bir
// süre sınırına hiç takılmadığı için orası değiştirilmedi.)
export async function fetchMatchingGmailMessages(
  user: string,
  appPassword: string,
  fromAddress: string,
  subjectContains: string,
  newerThanDays: number,
): Promise<RawGmailMessage[]> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass: appPassword },
    logger: false,
  });

  const messages: RawGmailMessage[] = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - newerThanDays * 24 * 60 * 60 * 1000);

      // IMAP SEARCH'te SUBJECT/FROM alt-string eşleşmesi yapar (Gmail API'nin
      // q= aramasındaki gibi tam bir "içerir" değil ama pratikte aynı işi
      // görüyor — konu satırı hep birebir aynı, adres tam eşleşiyor).
      const uids = await client.search(
        { from: fromAddress, subject: subjectContains, since },
        { uid: true },
      );

      // .search() eşleşme yoksa `false` dönüyor (boş dizi değil), IMAP'ın
      // kendine has davranışı.
      for (const uid of uids || []) {
        const { content } = await client.download(String(uid), undefined, { uid: true });
        const parsed = await simpleParser(content);

        // Message-ID header'ı, Supabase'deki gmail_message_id kolonunun
        // beklediği "her e-posta için sabit, tekrar aynı gelmeyecek kimlik"
        // şartını IMAP tarafında da karşılıyor — uid, kutu yeniden
        // düzenlendiğinde değişebildiği için buna güvenilmiyor.
        const id = parsed.messageId ?? `imap-uid-${uid}`;
        const html = typeof parsed.html === "string" ? parsed.html : (parsed.textAsHtml ?? null);
        messages.push({ id, html });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return messages;
}
