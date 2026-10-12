// Ayrıştırılmış bir ekstreyi veritabanındaki harcamalarla karşılaştırır ve
// aradaki farkları "bulgu" olarak döner. Burada hiçbir şey yazılmaz; bulgunun
// uygulanması (ekleme, düzeltme, onaya sunma) çağıranın işi.

import type { ParsedStatement, StatementTransaction } from "./statement.js";

export interface DbExpense {
  id: string;
  cardLast4: string;
  merchant: string;
  amount: number;
  /** ISO 8601 */
  transactionAt: string;
}

export type Finding =
  /** Ekstrede var, veritabanında karşılığı yok. */
  | { kind: "missing"; cardLast4: string; transaction: StatementTransaction }
  /** Veritabanında tek çekim duruyor, ekstrede taksitlendirilmiş. */
  | { kind: "convert_to_installment"; expense: DbExpense; transaction: StatementTransaction }
  /** Aynı taksit veritabanında farklı tutarla kayıtlı. */
  | { kind: "amount_mismatch"; expense: DbExpense; transaction: StatementTransaction }
  /** Banka işlemi aynı ekstrede geri almış, veritabanında hâlâ duruyor. */
  | { kind: "reversed"; expense: DbExpense; transaction: StatementTransaction }
  /** Ekstrede karşılığı olmayan bir alacak kaydı (önceki dönemden bir iade). */
  | { kind: "refund"; cardLast4: string; transaction: StatementTransaction }
  /** Veritabanında var, ekstrede yok. */
  | { kind: "extra"; expense: DbExpense };

export interface ReconcileOptions {
  /**
   * Bir önceki ekstrenin kesim tarihi (YYYY-AA-GG). Bilinmiyorsa kesimden bir
   * ay öncesi varsayılır ve dönem başındaki kayıtlar için "ekstrede yok"
   * bulgusu üretilmez (hangi ekstreye ait oldukları kesin değil).
   */
  previousCutoffDate?: string;
}

// Uygulamanın taksit kayıtlarına eklediği ek: "ORNEK MAGAZA (2/3 taksit)".
const INSTALLMENT_SUFFIX = / \((\d+)\/(\d+) taksit\)$/;

// Türkiye yaz saati uygulamıyor; yerel tarih için sabit +03:00 yeterli.
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const kurus = (amount: number) => Math.round(amount * 100);
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const localDayNumber = (iso: string) => Math.floor((Date.parse(iso) + ISTANBUL_OFFSET_MS) / DAY_MS);

function oneMonthBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

/// Banka ekstresi ile bildirim maili aynı işyerini farklı yazabiliyor
/// (İ/I, Ş/S, boşluk, kısaltma); karşılaştırma için ikisini de sadeleştirir.
function normalizeName(name: string): string {
  return name
    .toLocaleUpperCase("tr-TR")
    .replace(/İ/g, "I")
    .replace(/Ş/g, "S")
    .replace(/Ğ/g, "G")
    .replace(/Ü/g, "U")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/[^A-Z0-9]/g, "");
}

function similarNames(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  const prefix = Math.min(6, left.length, right.length);
  return prefix > 0 && left.slice(0, prefix) === right.slice(0, prefix);
}

interface Entry {
  cardLast4: string;
  transaction: StatementTransaction;
  cancelled: boolean;
}

export function reconcile(
  statement: ParsedStatement,
  expenses: DbExpense[],
  options: ReconcileOptions = {},
): Finding[] {
  if (!statement.cutoffDate) throw new Error("Kesim tarihi olmayan ekstre karşılaştırılamaz.");

  const cutoffDay = dayNumber(statement.cutoffDate);
  const previousCutoffKnown = Boolean(options.previousCutoffDate);
  const windowStartDay = dayNumber(options.previousCutoffDate ?? oneMonthBefore(statement.cutoffDate));

  const findings: Finding[] = [];
  const available = new Set(expenses);
  const dayOf = new Map(expenses.map((expense) => [expense, localDayNumber(expense.transactionAt)]));

  // Elle girilmiş kayıtlarda kart bilinmeyebiliyor ("----"); o zaman kart
  // eşleşmesi aranmıyor.
  const sameCard = (expense: DbExpense, cardLast4: string) =>
    !/^\d{4}$/.test(expense.cardLast4) || expense.cardLast4 === cardLast4;

  const suffixOf = (expense: DbExpense) => {
    const match = expense.merchant.match(INSTALLMENT_SUFFIX);
    return match ? { index: parseInt(match[1], 10), count: parseInt(match[2], 10) } : null;
  };

  /// Koşula uyan boştaki kayıtlardan en düşük puanlıyı alır ve havuzdan çıkarır.
  const take = (matches: (expense: DbExpense) => boolean, score: (expense: DbExpense) => number) => {
    let best: DbExpense | null = null;
    for (const expense of available) {
      if (matches(expense) && (best === null || score(expense) < score(best))) best = expense;
    }
    if (best) available.delete(best);
    return best;
  };

  const entries: Entry[] = statement.cards.flatMap((card) =>
    card.transactions.map((transaction) => ({ cardLast4: card.cardLast4, transaction, cancelled: false })),
  );
  const debits = entries.filter((entry) => entry.transaction.amount > 0);
  const credits = entries.filter((entry) => entry.transaction.amount < 0);

  // Banka bir işlemi aynı ekstrede geri alabiliyor: sonradan taksitlendirme
  // (tam tutar + geri alınması + ilk taksit) ya da iptal. Geri alma satırı
  // başka kartın bölümünde görünebildiği için eşleşme kartlar arası aranıyor.
  for (const credit of credits) {
    const debit = debits.find(
      (entry) =>
        !entry.cancelled &&
        kurus(entry.transaction.amount) === -kurus(credit.transaction.amount) &&
        entry.transaction.description === credit.transaction.description,
    );
    if (debit) {
      debit.cancelled = true;
      credit.cancelled = true;
    }
  }

  const unmatched: Entry[] = [];

  // 1. Birebir eşleşenler.
  for (const entry of debits) {
    if (entry.cancelled) continue;
    const { transaction, cardLast4 } = entry;
    const transactionDay = dayNumber(transaction.date);
    const installment = transaction.installment;

    const match = installment
      ? // Taksit satırındaki tarih ilk alışverişin tarihi; veritabanındaki
        // kayıt ise o dönemin herhangi bir gününde olabilir. Uygulama taksiti
        // eşit böldüğü için 1 kuruş fark eşleşme sayılıyor.
        take(
          (expense) => {
            const suffix = suffixOf(expense);
            const day = dayOf.get(expense)!;
            return (
              sameCard(expense, cardLast4) &&
              Math.abs(kurus(expense.amount) - kurus(transaction.amount)) <= 1 &&
              day >= windowStartDay - 1 &&
              day < cutoffDay &&
              (!suffix || (suffix.index === installment.index && suffix.count === installment.count))
            );
          },
          (expense) =>
            (suffixOf(expense) ? 0 : 1000) +
            Math.abs(kurus(expense.amount) - kurus(transaction.amount)) * 100 +
            Math.abs(dayOf.get(expense)! - transactionDay) / 1000,
        )
      : take(
          (expense) =>
            sameCard(expense, cardLast4) &&
            kurus(expense.amount) === kurus(transaction.amount) &&
            Math.abs(dayOf.get(expense)! - transactionDay) <= 1,
          (expense) => Math.abs(dayOf.get(expense)! - transactionDay),
        );

    if (!match) unmatched.push(entry);
  }

  for (const entry of unmatched) {
    const { transaction, cardLast4 } = entry;
    const installment = transaction.installment;

    if (installment) {
      // 2. Aynı taksit farklı tutarla kayıtlı.
      const mismatched = take(
        (expense) => {
          const suffix = suffixOf(expense);
          const day = dayOf.get(expense)!;
          return (
            sameCard(expense, cardLast4) &&
            suffix !== null &&
            suffix.index === installment.index &&
            suffix.count === installment.count &&
            day >= windowStartDay - 1 &&
            day < cutoffDay &&
            similarNames(expense.merchant.replace(INSTALLMENT_SUFFIX, ""), transaction.description)
          );
        },
        (expense) => Math.abs(kurus(expense.amount) - kurus(transaction.amount)),
      );
      if (mismatched) {
        findings.push({ kind: "amount_mismatch", expense: mismatched, transaction });
        continue;
      }

      // 3. Veritabanında işlemin tamamı tek çekim olarak duruyor.
      const single = take(
        (expense) =>
          sameCard(expense, cardLast4) &&
          suffixOf(expense) === null &&
          kurus(expense.amount) === kurus(installment.totalAmount) &&
          Math.abs(dayOf.get(expense)! - dayNumber(transaction.date)) <= 1,
        (expense) => Math.abs(dayOf.get(expense)! - dayNumber(transaction.date)),
      );
      if (single) {
        findings.push({ kind: "convert_to_installment", expense: single, transaction });
        continue;
      }
    }

    // 4. Veritabanında hiç karşılığı yok.
    findings.push({ kind: "missing", cardLast4, transaction });
  }

  // 5. Bankanın geri aldığı işlem veritabanında hâlâ duruyor.
  for (const entry of debits) {
    if (!entry.cancelled) continue;
    const { transaction, cardLast4 } = entry;
    const transactionDay = dayNumber(transaction.date);
    const leftover = take(
      (expense) =>
        sameCard(expense, cardLast4) &&
        kurus(expense.amount) === kurus(transaction.amount) &&
        Math.abs(dayOf.get(expense)! - transactionDay) <= 1,
      (expense) => Math.abs(dayOf.get(expense)! - transactionDay),
    );
    if (leftover) findings.push({ kind: "reversed", expense: leftover, transaction });
  }

  // 6. Karşılığı bu ekstrede olmayan alacak kayıtları.
  for (const entry of credits) {
    if (!entry.cancelled) {
      findings.push({ kind: "refund", cardLast4: entry.cardLast4, transaction: entry.transaction });
    }
  }

  // 7. Dönemin içinde olup ekstrede görünmeyen kayıtlar. Kesim günündeki ve
  // dönem başındaki işlemler komşu ekstreye düşebildiği için o günler hariç
  // tutuluyor. Uygulamanın ürettiği taksit kayıtları tam dönem başına
  // damgalandığından, önceki kesim tarihi biliniyorsa o gün de dahil ediliyor.
  for (const expense of available) {
    const day = dayOf.get(expense)!;
    const fromDay = previousCutoffKnown && suffixOf(expense) ? windowStartDay : windowStartDay + 1;
    if (day >= fromDay && day < cutoffDay) findings.push({ kind: "extra", expense });
  }

  return findings;
}
