import * as cheerio from "cheerio";

export interface ParsedExpense {
  cardLast4: string;
  cardType: string;
  merchant: string;
  amount: number;
  transactionAt: string; // ISO 8601, +03:00
  /**
   * "Kredi Kartı Kullanılabilir Limitiniz" değeri — sadece fiziksel kart
   * e-postalarında anlamlı (dijital/sanal kartın limitini kullanıcı kendi
   * belirliyor, o yüzden onun için hiç doldurulmuyor).
   */
  availableLimit: number | null;
}

// Örnek: "0645 ile biten Worldcard kartınız ile EMAAR BURGER KING firmasından
// 04.08.2026 tarihinde 17:13 saatinde 32,00 TL tutarında işlem gerçekleştirilmiştir."
// Kart tipi "Worldcard" veya "Worldcard dijital" gibi ek nitelendirmeler
// içerebiliyor (fiziksel/sanal kart farkı), bu yüzden (.+?) ile esnek tutuluyor.
const TRANSACTION_PATTERN =
  /(\d{4}) ile biten (.+?) kartınız ile (.+?) firmasından (\d{2})\.(\d{2})\.(\d{4}) tarihinde (\d{2}):(\d{2}) saatinde ([\d.,]+) TL tutarında işlem gerçekleştirilmiştir/;

const AVAILABLE_LIMIT_PATTERN = /Kredi Kartı Kullanılabilir Limitiniz: ([\d.,]+) TL/;

export function extractBodyText(html: string): string {
  const $ = cheerio.load(html);
  return $("body").text().replace(/\s+/g, " ").trim();
}

export function parseExpenseEmail(bodyText: string): ParsedExpense | null {
  const match = bodyText.match(TRANSACTION_PATTERN);
  if (!match) return null;

  const [
    ,
    cardLast4,
    cardType,
    merchant,
    day,
    month,
    year,
    hour,
    minute,
    amountStr,
  ] = match;

  const amount = parseFloat(amountStr.replace(/\./g, "").replace(",", "."));
  const transactionAt = `${year}-${month}-${day}T${hour}:${minute}:00+03:00`;

  const isDigital = cardType.toLowerCase().includes("dijital");
  const limitMatch = isDigital ? null : bodyText.match(AVAILABLE_LIMIT_PATTERN);
  const availableLimit = limitMatch
    ? parseFloat(limitMatch[1].replace(/\./g, "").replace(",", "."))
    : null;

  return {
    cardLast4,
    cardType,
    merchant: merchant.trim(),
    amount,
    transactionAt,
    availableLimit,
  };
}
