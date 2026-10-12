// Bir bulgunun veritabanında nasıl düzeltileceğini hesaplar. Burada hiçbir
// şey yazılmaz; dönen `Fix` çağıran tarafından uygulanır. Kendiliğinden
// düzeltilmesi güvenli olmayan bulgular (silme gerektirenler ve iadeler) için
// null döner — onlar kullanıcının onayını bekler.

import type { DbExpense, Finding } from "./reconcile.js";
import type { ParsedStatement } from "./statement.js";

/** Düzeltme için gereken ek alanlarıyla bir `expenses` satırı. */
export interface ExpenseRow extends DbExpense {
  gmailMessageId: string;
  cardType: string;
  category: string | null;
}

export interface NewExpense {
  cardLast4: string;
  cardType: string;
  merchant: string;
  amount: number;
  transactionAt: string;
}

export interface NewInstallmentPlan {
  merchantBase: string;
  totalAmount: number;
  installmentCount: number;
  cardLast4: string;
  cardType: string;
  category: string | null;
  nextDueBoundary: string;
  nextIndex: number;
  sourceExpenseId: string;
}

export interface Fix {
  insertExpense?: NewExpense;
  updateExpense?: { id: string; merchant?: string; amount: number };
  insertPlan?: NewInstallmentPlan;
  /** Aynı işyeri/kart/taksit sayısındaki planın toplam tutarını düzeltir. */
  updatePlanTotal?: { merchantBase: string; cardLast4: string; installmentCount: number; totalAmount: number };
}

export interface FixContext {
  statement: ParsedStatement;
  /** Uygulamanın kullanıcı için kullandığı kesim günü (`user_settings.cutoff_day`). */
  cutoffDay: number;
}

const INSTALLMENT_SUFFIX = / \(\d+\/\d+ taksit\)$/;
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

const installmentLabel = (index: number, count: number) => `(${index}/${count} taksit)`;

/// Ekstredeki açıklamanın sonundaki ülke kodunu atar: "ORNEK MARKET İSTANBUL TR".
/// Banka Türkiye için hem "TR" hem "TU" yazıyor.
const merchantName = (description: string) => description.replace(/ T[RU]$/, "");

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/// Verilen andan sonraki ilk dönem sınırı (kesim gününün İstanbul saatiyle
/// 00:00'ı). Uygulamadaki `StatementCycle.currentPeriod(asOf:).end` ile aynı;
/// otomatik taksit üretimi plandaki bu sınırı bekliyor.
export function nextPeriodBoundary(iso: string, cutoffDay: number): string {
  const local = new Date(Date.parse(iso) + ISTANBUL_OFFSET_MS);
  let boundary = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), cutoffDay);
  if (local.getTime() >= boundary) {
    boundary = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, cutoffDay);
  }
  return new Date(boundary - ISTANBUL_OFFSET_MS).toISOString();
}

export function planFix(finding: Finding, context: FixContext): Fix | null {
  switch (finding.kind) {
    case "missing": {
      const { transaction, cardLast4 } = finding;
      const card = context.statement.cards.find((entry) => entry.cardLast4 === cardLast4);
      const installment = transaction.installment;
      // Sonraki taksitlerde ekstredeki tarih aylar önceki alışverişe ait;
      // kayıt bu ekstrenin dönemine düşsün diye kesimden bir gün öncesine
      // yazılıyor. Saat ekstrede yok, öğlen varsayılıyor.
      const date =
        installment && installment.index > 1 ? dayBefore(context.statement.cutoffDate!) : transaction.date;
      const name = merchantName(transaction.description);
      return {
        insertExpense: {
          cardLast4,
          cardType: card?.isDigital ? "Worldcard dijital" : "Worldcard",
          merchant: installment ? `${name} ${installmentLabel(installment.index, installment.count)}` : name,
          amount: transaction.amount,
          transactionAt: `${date}T12:00:00+03:00`,
        },
      };
    }

    case "convert_to_installment": {
      const expense = finding.expense as ExpenseRow;
      const installment = finding.transaction.installment!;
      const fix: Fix = {
        updateExpense: {
          id: expense.id,
          merchant: `${expense.merchant} ${installmentLabel(installment.index, installment.count)}`,
          amount: finding.transaction.amount,
        },
      };
      // Kalan taksitleri uygulama, bu plana bakarak her dönem başında üretiyor.
      if (installment.index < installment.count) {
        fix.insertPlan = {
          merchantBase: expense.merchant,
          totalAmount: installment.totalAmount,
          installmentCount: installment.count,
          cardLast4: expense.cardLast4,
          cardType: expense.cardType,
          category: expense.category,
          nextDueBoundary: nextPeriodBoundary(expense.transactionAt, context.cutoffDay),
          nextIndex: installment.index + 1,
          sourceExpenseId: expense.gmailMessageId,
        };
      }
      return fix;
    }

    case "amount_mismatch": {
      const { expense, transaction } = finding;
      const installment = transaction.installment!;
      return {
        updateExpense: { id: expense.id, amount: transaction.amount },
        // Plan yanlış toplamla kalırsa sonraki taksitler de yanlış üretilir.
        updatePlanTotal: {
          merchantBase: expense.merchant.replace(INSTALLMENT_SUFFIX, ""),
          cardLast4: expense.cardLast4,
          installmentCount: installment.count,
          totalAmount: installment.totalAmount,
        },
      };
    }

    case "reversed":
    case "refund":
    case "extra":
      return null;
  }
}
