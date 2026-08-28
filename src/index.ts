import "dotenv/config";
import { gmail_v1 } from "googleapis";
import { getGmailClient, fetchMatchingMessages, extractHtmlBody } from "./gmail.js";
import { fetchMatchingOutlookMessages, extractOutlookHtmlBody } from "./outlook.js";
import { extractBodyText, parseExpenseEmail } from "./parser.js";
import { insertExpense, getDeviceTokens } from "./supabase.js";
import { sendPushNotification } from "./push.js";

const FROM_ADDRESS = "yapikredi@iletisim.yapikredi.com.tr";
const SUBJECT = "Akıllı Asistan Bilgilendirmesi";
const NEWER_THAN_DAYS = 2;

const GMAIL_QUERY = `from:${FROM_ADDRESS} subject:"${SUBJECT}" newer_than:${NEWER_THAN_DAYS}d`;

interface RawMessage {
  id: string;
  html: string | null;
}

interface Account {
  label: string;
  expenseUserId: string;
  fetchMessages: () => Promise<RawMessage[]>;
}

function buildAccounts(): Account[] {
  const accounts: Account[] = [];

  if (process.env.EXPENSE_USER_ID) {
    accounts.push({
      label: "gmail",
      expenseUserId: process.env.EXPENSE_USER_ID,
      fetchMessages: async () => {
        const gmail = getGmailClient();
        const messages = await fetchMatchingMessages(gmail, GMAIL_QUERY);
        return messages
          .filter((m): m is gmail_v1.Schema$Message & { id: string } => !!m.id)
          .map((m) => ({ id: m.id, html: extractHtmlBody(m.payload) }));
      },
    });
  }

  if (process.env.MS_REFRESH_TOKEN && process.env.EXPENSE_USER_ID_2) {
    accounts.push({
      label: "outlook",
      expenseUserId: process.env.EXPENSE_USER_ID_2,
      fetchMessages: async () => {
        const messages = await fetchMatchingOutlookMessages(
          process.env.MS_CLIENT_ID!,
          process.env.MS_REFRESH_TOKEN!,
          FROM_ADDRESS,
          SUBJECT,
          NEWER_THAN_DAYS,
        );
        return messages.map((m) => ({ id: m.id, html: extractOutlookHtmlBody(m) }));
      },
    });
  }

  return accounts;
}

/// Yeni bir işlem eklendiğinde kullanıcının kayıtlı tüm cihazlarına push
/// bildirimi gönderir — APNs kimlik bilgileri (APNS_KEY_ID vb.) hiç
/// ayarlanmamışsa özelliği sessizce atlar, tek bir cihazın push'u
/// başarısız olursa (ör. token artık geçersiz) diğerlerini ve senkronun
/// geri kalanını etkilemez.
async function notifyNewExpense(userId: string, merchant: string, amount: number): Promise<void> {
  if (!process.env.APNS_KEY_ID) return;

  const formattedAmount = amount.toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  try {
    const tokens = await getDeviceTokens(userId);
    await Promise.all(
      tokens.map((token) =>
        sendPushNotification(token, "Yeni harcama", `${merchant} — ${formattedAmount} TL`).catch((err) =>
          console.warn(`Push gönderilemedi (${token.slice(0, 8)}…):`, err.message ?? err),
        ),
      ),
    );
  } catch (err) {
    console.warn("Cihaz token'ları okunamadı, push atlanıyor:", err);
  }
}

async function processAccount(account: Account): Promise<boolean> {
  let hadError = false;
  const messages = await account.fetchMessages();
  console.log(`[${account.label}] ${messages.length} eşleşen e-posta bulundu.`);

  for (const message of messages) {
    try {
      if (!message.html) {
        console.warn(`[${account.label}:${message.id}] HTML gövde bulunamadı, atlanıyor.`);
        continue;
      }

      const bodyText = extractBodyText(message.html);
      const parsed = parseExpenseEmail(bodyText);

      if (!parsed) {
        console.warn(`[${account.label}:${message.id}] Beklenen kalıpla eşleşmedi, atlanıyor.`);
        continue;
      }

      const result = await insertExpense(message.id, parsed, account.expenseUserId);
      if (result === "inserted") {
        console.log(
          `[${account.label}:${message.id}] Eklendi: ${parsed.merchant} — ${parsed.amount.toFixed(2)} TL (${parsed.transactionAt})`,
        );
        await notifyNewExpense(account.expenseUserId, parsed.merchant, parsed.amount);
      } else {
        console.log(`[${account.label}:${message.id}] Zaten işlenmiş, atlandı.`);
      }
    } catch (err) {
      console.error(`[${account.label}:${message.id}] İşlenirken hata oluştu, atlanıyor:`, err);
      hadError = true;
    }
  }

  return hadError;
}

async function main() {
  const accounts = buildAccounts();
  if (accounts.length === 0) {
    console.warn("Yapılandırılmış bir hesap yok (EXPENSE_USER_ID / MS_REFRESH_TOKEN eksik).");
    return;
  }

  let hadError = false;
  for (const account of accounts) {
    const accountHadError = await processAccount(account);
    hadError = hadError || accountHadError;
  }

  if (hadError) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
