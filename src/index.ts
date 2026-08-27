import "dotenv/config";
import { gmail_v1 } from "googleapis";
import { getGmailClient, fetchMatchingMessages, extractHtmlBody } from "./gmail.js";
import { fetchMatchingOutlookMessages, extractOutlookHtmlBody } from "./outlook.js";
import { extractBodyText, parseExpenseEmail } from "./parser.js";
import { insertExpense } from "./supabase.js";

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
