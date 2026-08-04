import "dotenv/config";
import { getGmailClient, fetchMatchingMessages, extractHtmlBody } from "./gmail.js";
import { extractBodyText, parseExpenseEmail } from "./parser.js";
import { insertExpense } from "./supabase.js";

const QUERY =
  'from:yapikredi@iletisim.yapikredi.com.tr subject:"Akıllı Asistan Bilgilendirmesi" newer_than:2d';

async function main() {
  const gmail = getGmailClient();
  const messages = await fetchMatchingMessages(gmail, QUERY);

  console.log(`${messages.length} eşleşen e-posta bulundu.`);

  let hadError = false;

  for (const message of messages) {
    if (!message.id) continue;

    try {
      const html = extractHtmlBody(message.payload);
      if (!html) {
        console.warn(`[${message.id}] HTML gövde bulunamadı, atlanıyor.`);
        continue;
      }

      const bodyText = extractBodyText(html);
      const parsed = parseExpenseEmail(bodyText);

      if (!parsed) {
        console.warn(`[${message.id}] Beklenen kalıpla eşleşmedi, atlanıyor.`);
        continue;
      }

      const result = await insertExpense(message.id, parsed);
      if (result === "inserted") {
        console.log(
          `[${message.id}] Eklendi: ${parsed.merchant} — ${parsed.amount.toFixed(2)} TL (${parsed.transactionAt})`,
        );
      } else {
        console.log(`[${message.id}] Zaten işlenmiş, atlandı.`);
      }
    } catch (err) {
      console.error(`[${message.id}] İşlenirken hata oluştu, atlanıyor:`, err);
      hadError = true;
    }
  }

  if (hadError) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
