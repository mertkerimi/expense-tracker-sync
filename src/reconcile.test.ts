import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcile, type DbExpense } from "./reconcile.js";
import type { ParsedStatement, StatementInstallment, StatementTransaction } from "./statement.js";

// Uydurma veri — repo herkese açık olduğu için buraya gerçek işlem konmuyor.

function transaction(
  date: string,
  description: string,
  amount: number,
  installment: StatementInstallment | null = null,
): StatementTransaction {
  return { date, description, amount, installment };
}

function statement(
  physical: StatementTransaction[],
  digital: StatementTransaction[] = [],
  cutoffDate = "2026-09-27",
): ParsedStatement {
  return {
    cutoffDate,
    dueDate: null,
    nextCutoffDate: null,
    nextDueDate: null,
    periodDebt: null,
    periodSpending: null,
    cards: [
      { cardLast4: "1111", isDigital: false, transactions: physical, previousDebt: 0, payments: 0, statedTotal: null },
      { cardLast4: "2222", isDigital: true, transactions: digital, previousDebt: 0, payments: 0, statedTotal: null },
    ],
  };
}

let nextId = 0;
/** `localTime` İstanbul saatiyle "YYYY-AA-GG SS:DD". */
function expense(localTime: string, merchant: string, amount: number, cardLast4 = "1111"): DbExpense {
  return {
    id: String(++nextId),
    cardLast4,
    merchant,
    amount,
    transactionAt: `${localTime.replace(" ", "T")}:00+03:00`,
  };
}

const kinds = (findings: ReturnType<typeof reconcile>) => findings.map((finding) => finding.kind);

test("her şey eşleşiyorsa bulgu üretmez", () => {
  const findings = reconcile(
    statement(
      [transaction("2026-09-05", "ORNEK MARKET İSTANBUL TR", 250), transaction("2026-09-05", "ORNEK MARKET İSTANBUL TR", 250)],
      [transaction("2026-09-09", "ORNEK ABONELIK CORK IR", 99.99)],
    ),
    [
      expense("2026-09-05 10:00", "ORNEK MARKET", 250),
      expense("2026-09-05 18:30", "ORNEK MARKET", 250),
      expense("2026-09-09 03:58", "ORNEK ABONELIK", 99.99, "2222"),
    ],
  );
  assert.deepEqual(findings, []);
});

test("gece yarısına yakın işlem bir gün farkla eşleşir", () => {
  const findings = reconcile(statement([transaction("2026-09-10", "ORNEK BUFE İSTANBUL TR", 80)]), [
    expense("2026-09-09 23:50", "ORNEK BUFE", 80),
  ]);
  assert.deepEqual(findings, []);
});

test("veritabanında olmayan işlemi eksik olarak bildirir", () => {
  const fee = transaction("2026-09-01", "TAKSITLENDIRME İŞLEM FAIZI", 20.5);
  const findings = reconcile(statement([], [fee]), []);
  assert.deepEqual(findings, [{ kind: "missing", cardLast4: "2222", transaction: fee }]);
});

test("aynı tutar başka karttaysa eşleştirmez", () => {
  const findings = reconcile(statement([transaction("2026-09-05", "ORNEK MARKET İSTANBUL TR", 250)]), [
    expense("2026-09-05 10:00", "ORNEK MARKET", 250, "2222"),
  ]);
  assert.deepEqual(kinds(findings), ["missing", "extra"]);
});

test("kartı bilinmeyen elle girilmiş taksiti tutar ve taksit numarasıyla eşleştirir", () => {
  const findings = reconcile(
    statement([], [transaction("2025-12-28", "ORNEK MAGAZA SANAL ISTANBUL TR", 1000.33, { totalAmount: 9003, index: 9, count: 9 })]),
    [expense("2026-08-27 00:00", "Elle girilen (9/9 taksit)", 1000.33, "----")],
  );
  assert.deepEqual(findings, []);
});

test("uygulamanın eşit böldüğü taksitte 1 kuruş farkı yok sayar", () => {
  const findings = reconcile(
    statement([], [transaction("2026-09-01", "ORNEK KURUM ANKARA TR", 100.01, { totalAmount: 300.01, index: 1, count: 3 })]),
    [expense("2026-09-01 16:41", "ORNEK KURUM (1/3 taksit)", 100, "2222")],
  );
  assert.deepEqual(findings, []);
});

test("aynı taksit farklı tutarla kayıtlıysa tutar uyuşmazlığı bildirir", () => {
  const installment = transaction("2026-08-18", "ORNEKSITE ISTANBUL TR", 8600, { totalAmount: 25800, index: 2, count: 3 });
  const stored = expense("2026-08-27 00:00", "ORNEKSITE (2/3 taksit)", 8700, "2222");
  const findings = reconcile(statement([], [installment]), [stored]);
  assert.deepEqual(findings, [{ kind: "amount_mismatch", expense: stored, transaction: installment }]);
});

test("sonradan taksitlendirilen işlemi tek çekim kaydından dönüştürmeyi önerir", () => {
  const first = transaction("2026-09-01", "ORNEK KURUM ANKARA TR", 200, { totalAmount: 600, index: 1, count: 3 });
  const stored = expense("2026-09-01 16:41", "ORNEK KURUM", 600, "2222");
  const findings = reconcile(
    statement(
      // Geri alma satırı fiziksel kartın bölümünde görünüyor.
      [transaction("2026-09-07", "ORNEK KURUM ANKARA TR", -600)],
      [transaction("2026-09-01", "ORNEK KURUM ANKARA TR", 600), first],
    ),
    [stored],
  );
  assert.deepEqual(findings, [{ kind: "convert_to_installment", expense: stored, transaction: first }]);
});

test("bankanın aynı ekstrede geri aldığı işlem veritabanında duruyorsa bildirir", () => {
  const charge = transaction("2026-09-14", "ORNEKSITE ISTANBUL TR", 750.4);
  const stored = expense("2026-09-14 23:39", "ORNEKSITE", 750.4, "2222");
  const findings = reconcile(statement([], [charge, transaction("2026-09-27", "ORNEKSITE ISTANBUL TR", -750.4)]), [stored]);
  assert.deepEqual(findings, [{ kind: "reversed", expense: stored, transaction: charge }]);
});

test("karşılığı olmayan alacak kaydını iade olarak bildirir", () => {
  const credit = transaction("2026-09-12", "ORNEK MAGAZA ISTANBUL TR", -450);
  const findings = reconcile(statement([credit]), []);
  assert.deepEqual(findings, [{ kind: "refund", cardLast4: "1111", transaction: credit }]);
});

test("dönem içinde olup ekstrede olmayan kaydı fazla olarak bildirir", () => {
  const stray = expense("2026-09-15 12:00", "ORNEK MARKET", 75);
  assert.deepEqual(reconcile(statement([]), [stray]), [{ kind: "extra", expense: stray }]);
});

test("kesim günündeki ve dönem dışındaki kayıtları fazla saymaz", () => {
  const findings = reconcile(statement([]), [
    expense("2026-09-27 09:00", "KESIM GUNU", 10),
    expense("2026-09-28 09:00", "SONRAKI DONEM", 10),
    expense("2026-08-27 09:00", "DONEM BASI", 10),
    expense("2026-08-20 09:00", "ONCEKI DONEM", 10),
  ]);
  assert.deepEqual(findings, []);
});

test("önceki kesim biliniyorsa dönem başına damgalanmış çift taksit kaydını yakalar", () => {
  const installment = transaction("2026-09-01", "ORNEK KURUM ANKARA TR", 200, { totalAmount: 600, index: 2, count: 3 });
  const first = expense("2026-09-27 00:00", "ORNEK KURUM (2/3 taksit)", 200, "2222");
  const duplicate = expense("2026-09-27 00:00", "ORNEK KURUM (2/3 taksit)", 200, "2222");
  const october = statement([], [installment], "2026-10-26");

  assert.deepEqual(reconcile(october, [first, duplicate], { previousCutoffDate: "2026-09-27" }), [
    { kind: "extra", expense: duplicate },
  ]);
  // Önceki kesim bilinmiyorsa dönem başı kesimden bir ay öncesi (27 Eylül)
  // varsayılır ve o güne damgalı kayıt hangi ekstreye ait belli olmadığı için
  // bildirilmez.
  const guessed = statement([], [installment], "2026-10-27");
  assert.deepEqual(reconcile(guessed, [first, duplicate]), []);
});
