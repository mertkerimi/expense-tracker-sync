import assert from "node:assert/strict";
import { test } from "node:test";
import { nextPeriodBoundary, planFix, type ExpenseRow, type FixContext } from "./fixes.js";
import type { StatementTransaction } from "./statement.js";

// Uydurma veri — repo herkese açık olduğu için buraya gerçek işlem konmuyor.

const context: FixContext = {
  cutoffDay: 27,
  statement: {
    cutoffDate: "2026-09-27",
    dueDate: "2026-10-07",
    nextCutoffDate: "2026-10-26",
    nextDueDate: "2026-11-05",
    periodDebt: null,
    periodSpending: null,
    cards: [
      { cardLast4: "1111", isDigital: false, transactions: [], previousDebt: 0, payments: 0, statedTotal: null },
      { cardLast4: "2222", isDigital: true, transactions: [], previousDebt: 0, payments: 0, statedTotal: null },
    ],
  },
};

const stored: ExpenseRow = {
  id: "row-1",
  gmailMessageId: "<mail-1@example>",
  cardLast4: "2222",
  cardType: "Worldcard dijital",
  merchant: "ORNEK KURUM",
  amount: 600,
  transactionAt: "2026-09-01T16:41:00+03:00",
  category: "Diğer",
};

test("dönem sınırı: kesim gününden önceki işlem aynı ayın, sonraki işlem gelecek ayın sınırına düşer", () => {
  assert.equal(nextPeriodBoundary("2026-09-01T16:41:00+03:00", 27), "2026-09-26T21:00:00.000Z");
  assert.equal(nextPeriodBoundary("2026-09-28T10:58:00+03:00", 27), "2026-10-26T21:00:00.000Z");
  // Tam sınır anı yeni döneme aittir.
  assert.equal(nextPeriodBoundary("2026-09-27T00:00:00+03:00", 27), "2026-10-26T21:00:00.000Z");
  // UTC'ye göre önceki gün, İstanbul'a göre kesim günü.
  assert.equal(nextPeriodBoundary("2026-12-26T22:30:00Z", 27), "2027-01-26T21:00:00.000Z");
});

test("eksik işlem ekstredeki tarihle ve kartın türüyle eklenir", () => {
  const transaction: StatementTransaction = {
    date: "2026-09-04",
    description: "ORNEK MARKET İSTANBUL TR",
    amount: 12.5,
    installment: null,
  };
  assert.deepEqual(planFix({ kind: "missing", cardLast4: "1111", transaction }, context), {
    insertExpense: {
      cardLast4: "1111",
      cardType: "Worldcard",
      merchant: "ORNEK MARKET İSTANBUL",
      amount: 12.5,
      transactionAt: "2026-09-04T12:00:00+03:00",
    },
  });
});

test("eksik sonraki taksit bu ekstrenin dönemine, taksit etiketiyle eklenir", () => {
  const transaction: StatementTransaction = {
    date: "2026-06-10",
    description: "ORNEKSITE ISTANBUL TR",
    amount: 200,
    installment: { totalAmount: 600, index: 3, count: 3 },
  };
  assert.deepEqual(planFix({ kind: "missing", cardLast4: "2222", transaction }, context)?.insertExpense, {
    cardLast4: "2222",
    cardType: "Worldcard dijital",
    merchant: "ORNEKSITE ISTANBUL (3/3 taksit)",
    amount: 200,
    transactionAt: "2026-09-26T12:00:00+03:00",
  });
});

test("tek çekim kaydı ilk taksite çevrilir ve kalanlar için plan kurulur", () => {
  const transaction: StatementTransaction = {
    date: "2026-09-01",
    description: "ORNEK KURUM ANKARA TR",
    amount: 200,
    installment: { totalAmount: 600, index: 1, count: 3 },
  };
  assert.deepEqual(planFix({ kind: "convert_to_installment", expense: stored, transaction }, context), {
    updateExpense: { id: "row-1", merchant: "ORNEK KURUM (1/3 taksit)", amount: 200 },
    insertPlan: {
      merchantBase: "ORNEK KURUM",
      totalAmount: 600,
      installmentCount: 3,
      cardLast4: "2222",
      cardType: "Worldcard dijital",
      category: "Diğer",
      nextDueBoundary: "2026-09-26T21:00:00.000Z",
      nextIndex: 2,
      sourceExpenseId: "<mail-1@example>",
    },
  });
});

test("son taksit için plan kurulmaz", () => {
  const transaction: StatementTransaction = {
    date: "2026-09-01",
    description: "ORNEK KURUM ANKARA TR",
    amount: 600,
    installment: { totalAmount: 600, index: 1, count: 1 },
  };
  const fix = planFix({ kind: "convert_to_installment", expense: stored, transaction }, context);
  assert.equal(fix?.insertPlan, undefined);
});

test("tutar uyuşmazlığında hem kayıt hem planın toplamı düzeltilir", () => {
  const expense: ExpenseRow = { ...stored, merchant: "ORNEKSITE (2/3 taksit)", amount: 8700 };
  const transaction: StatementTransaction = {
    date: "2026-08-18",
    description: "ORNEKSITE ISTANBUL TR",
    amount: 8600,
    installment: { totalAmount: 25800, index: 2, count: 3 },
  };
  assert.deepEqual(planFix({ kind: "amount_mismatch", expense, transaction }, context), {
    updateExpense: { id: "row-1", amount: 8600 },
    updatePlanTotal: { merchantBase: "ORNEKSITE", cardLast4: "2222", installmentCount: 3, totalAmount: 25800 },
  });
});

test("silme gerektiren bulgular ve iadeler kendiliğinden düzeltilmez", () => {
  const transaction: StatementTransaction = { date: "2026-09-14", description: "X", amount: -10, installment: null };
  assert.equal(planFix({ kind: "extra", expense: stored }, context), null);
  assert.equal(planFix({ kind: "reversed", expense: stored, transaction }, context), null);
  assert.equal(planFix({ kind: "refund", cardLast4: "1111", transaction }, context), null);
});
