// Yapı Kredi "Worldcard Hesap Özeti" PDF'inden çıkarılmış metin satırlarını
// yapılandırılmış bir ekstreye çevirir. Girdi, PDF'in içerik sırasındaki
// satırlarıdır (her işlem tek satır: tarih, işyeri, tutar, varsa kalan
// tutar/taksit ve puan). PDF'ten metin çıkarma işi bu dosyanın dışında.

export interface StatementInstallment {
  index: number;
  count: number;
  /** Taksitlendirilen işlemin toplam tutarı (TL). */
  totalAmount: number;
}

export interface StatementTransaction {
  /** YYYY-AA-GG. Taksitlerde bu, taksidin değil ilk alışverişin tarihidir. */
  date: string;
  description: string;
  /** TL. Pozitif = borç, negatif = alacak (iade ya da geri alınan işlem). */
  amount: number;
  installment: StatementInstallment | null;
}

export interface StatementCard {
  cardLast4: string;
  isDigital: boolean;
  transactions: StatementTransaction[];
  /** Bölümün başındaki "ÖNCEKİ DÖNEM HESAP ÖZETİ BORCU" (yoksa 0). */
  previousDebt: number;
  /** Dönem içinde yapılan kart borcu ödemelerinin toplamı. */
  payments: number;
  /**
   * Kart bölümünün sonundaki "TOPLAM" satırı; bulunamadıysa null. Banka bunu
   * önceki borç − ödemeler + işlemler olarak hesaplıyor.
   */
  statedTotal: number | null;
}

export interface ParsedStatement {
  /** YYYY-AA-GG */
  cutoffDate: string | null;
  dueDate: string | null;
  /** Ekstrede yazan bir sonraki ayın kesim ve son ödeme tarihleri. */
  nextCutoffDate: string | null;
  nextDueDate: string | null;
  periodDebt: number | null;
  periodSpending: number | null;
  cards: StatementCard[];
}

const MONTHS: Record<string, string> = {
  Ocak: "01",
  Şubat: "02",
  Mart: "03",
  Nisan: "04",
  Mayıs: "05",
  Haziran: "06",
  Temmuz: "07",
  Ağustos: "08",
  Eylül: "09",
  Ekim: "10",
  Kasım: "11",
  Aralık: "12",
};

const MONTH = Object.keys(MONTHS).join("|");
const MONEY = String.raw`\d{1,3}(?:\.\d{3})*,\d{2}`;

// Örnek: "08 Ağustos 2026 ORNEK MAGAZA ISTANBUL TR 500,00 1.000,00 / 2 120"
// Sondaki iki grup (kalan tutar / kalan taksit ve puan) her satırda yok.
// Açıklama tembel eşleşiyor ki satırdaki ilk para biçimli değer tutar olsun.
const TRANSACTION_PATTERN = new RegExp(
  String.raw`^(\d{1,2}) (${MONTH}) (\d{4}) (.+?) (\+?${MONEY})(?: ${MONEY} / \d+)?(?: -?[\d.]+)?$`,
);

// Örnek: "2.000,00 TL'lik işlemin 2 / 4 taksidi" — bir önceki işlem satırına aittir.
const INSTALLMENT_PATTERN = new RegExp(String.raw`^(${MONEY}) TL['’]lik işlemin (\d+) / (\d+) taksidi$`);

// Örnek: "Kart Numarası :1234 56** **** 1111 AD SOYAD",
//        "Dijital Kart Numarası : 123456** ****2222 AD SOYAD"
const CARD_PATTERN = /^(Dijital )?Kart Numarası\s*:\s*([\d* ]*\d{4})(?: |$)/;

const PREVIOUS_DEBT_PATTERN = new RegExp(String.raw`^ÖNCEKİ DÖNEM HESAP ÖZETİ BORCU (${MONEY})$`);
const TOTAL_PATTERN = new RegExp(String.raw`^TOPLAM (${MONEY})`);
const DATE_FIELD = String.raw`\s*:\s*(\d{1,2}) (${MONTH}) (\d{4})`;
const CUTOFF_PATTERN = new RegExp(`^Hesap Kesim Tarihi${DATE_FIELD}`);
const DUE_PATTERN = new RegExp(`^Son Ödeme Tarihi${DATE_FIELD}`);
const NEXT_CUTOFF_PATTERN = new RegExp(`^Bir Sonraki Ay Hesap Kesim Tarihi${DATE_FIELD}`);
const NEXT_DUE_PATTERN = new RegExp(`^Bir Sonraki Ay Son Ödeme Tarihi${DATE_FIELD}`);
const DEBT_PATTERN = new RegExp(String.raw`^Dönem Borcu\s*:\s*(${MONEY}) TL`);
const SPENDING_PATTERN = new RegExp(String.raw`^Dönem İçi Harcamalar\s*:\s*(${MONEY}) TL`);

// Kart borcunun ödenmesi bir harcama ya da iade değil, o yüzden işlem
// listesine alınmıyor; tutarı kartın `payments` alanında toplanıyor.
const PAYMENT_PREFIX = "ÖDEME-";

/** "1.234,56" → 123456 (kuruş). Toplamlar kayan nokta hatası olmasın diye kuruşla tutuluyor. */
function toKurus(money: string): number {
  return parseInt(money.replace(/[+.,]/g, ""), 10);
}

function toIsoDate(day: string, month: string, year: string): string {
  return `${year}-${MONTHS[month]}-${day.padStart(2, "0")}`;
}

export function parseStatement(lines: string[]): ParsedStatement {
  const statement: ParsedStatement = {
    cutoffDate: null,
    dueDate: null,
    nextCutoffDate: null,
    nextDueDate: null,
    periodDebt: null,
    periodSpending: null,
    cards: [],
  };

  let currentCard: StatementCard | null = null;
  let lastTransaction: StatementTransaction | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    const cardMatch = line.match(CARD_PATTERN);
    if (cardMatch) {
      const cardLast4 = cardMatch[2].replace(/\D/g, "").slice(-4);
      // Aynı kartın başlığı her sayfada tekrar ediyor; tek bölümde toplanıyor.
      currentCard = statement.cards.find((card) => card.cardLast4 === cardLast4) ?? null;
      if (!currentCard) {
        currentCard = {
          cardLast4,
          isDigital: Boolean(cardMatch[1]),
          transactions: [],
          previousDebt: 0,
          payments: 0,
          statedTotal: null,
        };
        statement.cards.push(currentCard);
      }
      lastTransaction = null;
      continue;
    }

    const transactionMatch = line.match(TRANSACTION_PATTERN);
    if (transactionMatch && currentCard) {
      const [, day, month, year, description, amountStr] = transactionMatch;
      if (description.startsWith(PAYMENT_PREFIX)) {
        currentCard.payments = (Math.round(currentCard.payments * 100) + toKurus(amountStr)) / 100;
        lastTransaction = null;
        continue;
      }
      const kurus = toKurus(amountStr);
      lastTransaction = {
        date: toIsoDate(day, month, year),
        description,
        amount: (amountStr.startsWith("+") ? -kurus : kurus) / 100,
        installment: null,
      };
      currentCard.transactions.push(lastTransaction);
      continue;
    }

    const installmentMatch = line.match(INSTALLMENT_PATTERN);
    if (installmentMatch && lastTransaction) {
      lastTransaction.installment = {
        totalAmount: toKurus(installmentMatch[1]) / 100,
        index: parseInt(installmentMatch[2], 10),
        count: parseInt(installmentMatch[3], 10),
      };
      continue;
    }

    const previousDebtMatch = line.match(PREVIOUS_DEBT_PATTERN);
    if (previousDebtMatch && currentCard) {
      currentCard.previousDebt = toKurus(previousDebtMatch[1]) / 100;
      continue;
    }

    const totalMatch = line.match(TOTAL_PATTERN);
    if (totalMatch && currentCard) {
      currentCard.statedTotal = toKurus(totalMatch[1]) / 100;
      currentCard = null;
      lastTransaction = null;
      continue;
    }

    const cutoffMatch = line.match(CUTOFF_PATTERN);
    if (cutoffMatch) statement.cutoffDate ??= toIsoDate(cutoffMatch[1], cutoffMatch[2], cutoffMatch[3]);

    const dueMatch = line.match(DUE_PATTERN);
    if (dueMatch) statement.dueDate ??= toIsoDate(dueMatch[1], dueMatch[2], dueMatch[3]);

    const nextCutoffMatch = line.match(NEXT_CUTOFF_PATTERN);
    if (nextCutoffMatch) statement.nextCutoffDate ??= toIsoDate(nextCutoffMatch[1], nextCutoffMatch[2], nextCutoffMatch[3]);

    const nextDueMatch = line.match(NEXT_DUE_PATTERN);
    if (nextDueMatch) statement.nextDueDate ??= toIsoDate(nextDueMatch[1], nextDueMatch[2], nextDueMatch[3]);

    const debtMatch = line.match(DEBT_PATTERN);
    if (debtMatch) statement.periodDebt ??= toKurus(debtMatch[1]) / 100;

    const spendingMatch = line.match(SPENDING_PATTERN);
    if (spendingMatch) statement.periodSpending ??= toKurus(spendingMatch[1]) / 100;
  }

  return statement;
}

/// Ayrıştırmanın ekstreyle tutarlı olup olmadığını kontrol eder: her kartta
/// önceki borç − ödemeler + işlemler o kartın "TOPLAM" satırına, bütün
/// kartların işlem toplamı da "Dönem İçi Harcamalar"a eşit olmalı. Banka PDF
/// düzenini değiştirirse ayrıştırıcı sessizce satır atlayabilir; bu kontrol
/// tutmuyorsa ekstreye dayanarak veritabanında hiçbir şey değiştirilmemeli.
/// Boş dizi = sorun yok.
export function validateStatement(statement: ParsedStatement): string[] {
  const problems: string[] = [];
  const kurus = (amount: number) => Math.round(amount * 100);

  if (!statement.cutoffDate) problems.push("Hesap kesim tarihi bulunamadı.");
  if (statement.cards.length === 0) problems.push("Hiç kart bölümü bulunamadı.");

  let cardsTotal = 0;
  for (const card of statement.cards) {
    const sum = card.transactions.reduce((total, transaction) => total + kurus(transaction.amount), 0);
    cardsTotal += sum;
    const expectedTotal = kurus(card.previousDebt) - kurus(card.payments) + sum;
    if (card.statedTotal === null) {
      problems.push(`${card.cardLast4}: TOPLAM satırı bulunamadı.`);
    } else if (expectedTotal !== kurus(card.statedTotal)) {
      problems.push(
        `${card.cardLast4}: hesaplanan toplam ${(expectedTotal / 100).toFixed(2)}, ekstredeki TOPLAM ${card.statedTotal.toFixed(2)}.`,
      );
    }
  }

  if (statement.periodSpending === null) {
    problems.push("Dönem içi harcamalar bulunamadı.");
  } else if (cardsTotal !== kurus(statement.periodSpending)) {
    problems.push(
      `Kart toplamları ${(cardsTotal / 100).toFixed(2)}, dönem içi harcamalar ${statement.periodSpending.toFixed(2)}.`,
    );
  }

  return problems;
}
