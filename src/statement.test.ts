import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatement, validateStatement } from "./statement.js";

// Gerçek ekstre biçimini taklit eden uydurma veri — repo herkese açık olduğu
// için buraya gerçek işlem konmuyor.
const SAMPLE = [
  "HESAP BİLGİLERİ",
  "Hesap Kesim Tarihi :27 Eylül 2026",
  "Son Ödeme Tarihi : 7 Ekim 2026",
  "Dönem Borcu : 1.845,00 TL",
  "Dönem İçi Harcamalar : 1.845,00 TL",
  "Bir Sonraki Ay Hesap Kesim Tarihi : 26 Ekim 2026",
  "Bir Sonraki Ay Son Ödeme Tarihi : 5 Kasım 2026",
  "Kart Numarası : 1234 56** **** 1111",
  "Kart Numarası :1234 56** **** 1111 AD SOYAD",
  "İşlem Tarihi İşlemler Tutar(TL) Kalan Tutar/Taksit Puan",
  "ÖNCEKİ DÖNEM HESAP ÖZETİ BORCU 900,00",
  "07 Eylül 2026 ÖDEME-İNTERNET BANKACILIĞI +900,00",
  "10 Eylül 2026 ÖDEME-İNTERNET BANKACILIĞI +100,00",
  "26 Ağustos 2026 ORNEK MARKET 4155 İSTANBUL TR 1.000,00 160",
  "07 Eylül 2026 ORNEK KURUM ANKARA TR +300,00",
  "Temassız İşlem",
  "1 / 2 396",
  "08 Ağustos 2026 ORNEK MAGAZA ISTANBUL TR 500,00 1.000,00 / 2 120",
  "2.000,00 TL'lik işlemin 2 / 4 taksidi",
  "TOPLAM 1.100,00 432",
  "Dijital Kart Numarası : 123456** ****2222 AD SOYAD",
  "05 Eylül 2026 ORNEK ABONELIK CORK IRIR 399,99",
  "İşlem Tutarı: 399,99 TRY TRY Karşılığı : 399,99 TRY",
  "Dijital Kart Numarası : 123456** ****2222 AD SOYAD",
  "01 Eylül 2026 TAKSITLENDIRME İŞLEM FAIZI 45,01",
  "01 Eylül 2026 ORNEK KURUM ANKARA TR 200,00 400,00 / 2",
  "600,00 TL'lik işlemin 1 / 3 taksidi",
  "TOPLAM 645,00 162",
  "PUAN ÖZETİ",
];

test("başlık alanlarını okur", () => {
  const statement = parseStatement(SAMPLE);
  assert.equal(statement.cutoffDate, "2026-09-27");
  assert.equal(statement.dueDate, "2026-10-07");
  assert.equal(statement.nextCutoffDate, "2026-10-26");
  assert.equal(statement.nextDueDate, "2026-11-05");
  assert.equal(statement.periodDebt, 1845);
  assert.equal(statement.periodSpending, 1845);
});

test("işlemleri kartlara ayırır, sayfa başında tekrarlanan başlığı birleştirir", () => {
  const { cards } = parseStatement(SAMPLE);
  assert.deepEqual(
    cards.map((card) => [card.cardLast4, card.isDigital, card.transactions.length, card.statedTotal]),
    [
      ["1111", false, 3, 1100],
      ["2222", true, 3, 645],
    ],
  );
});

test("ödemeyi atlar, alacak kaydını negatif okur, puan sütununu tutar sanmaz", () => {
  const [physical] = parseStatement(SAMPLE).cards;
  assert.deepEqual(
    physical.transactions.map((transaction) => [transaction.date, transaction.description, transaction.amount]),
    [
      ["2026-08-26", "ORNEK MARKET 4155 İSTANBUL TR", 1000],
      ["2026-09-07", "ORNEK KURUM ANKARA TR", -300],
      ["2026-08-08", "ORNEK MAGAZA ISTANBUL TR", 500],
    ],
  );
});

test("taksit satırını bir önceki işleme bağlar", () => {
  const [physical, digital] = parseStatement(SAMPLE).cards;
  assert.deepEqual(physical.transactions[2].installment, { totalAmount: 2000, index: 2, count: 4 });
  assert.deepEqual(digital.transactions[2].installment, { totalAmount: 600, index: 1, count: 3 });
  assert.equal(digital.transactions[0].installment, null);
});

test("önceki borcu ve ödemeleri ayrı tutar", () => {
  const [physical, digital] = parseStatement(SAMPLE).cards;
  assert.deepEqual([physical.previousDebt, physical.payments], [900, 1000]);
  assert.deepEqual([digital.previousDebt, digital.payments], [0, 0]);
});

test("toplamlar tutuyorsa sorun bildirmez", () => {
  assert.deepEqual(validateStatement(parseStatement(SAMPLE)), []);
});

test("bir işlem satırı okunamazsa toplam uyuşmazlığını yakalar", () => {
  const broken = SAMPLE.map((line) => (line.startsWith("26 Ağustos") ? "26 Ağustos 2026 ORNEK MARKET" : line));
  const problems = validateStatement(parseStatement(broken));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^1111: hesaplanan toplam 100\.00/);
});
