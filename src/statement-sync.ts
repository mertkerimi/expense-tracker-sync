// Ekstre mailini uçtan uca işler: PDF'i okur, ayrıştırır, toplamları
// doğrular, veritabanıyla karşılaştırır, bulguları kaydeder, (izin verilmişse)
// güvenli olanları düzeltir ve sonucu push bildirimiyle haber verir.

import { planFix, type ExpenseRow } from "./fixes.js";
import { fetchStatementEmails, type StatementEmail } from "./gmail.js";
import { extractPdfLines } from "./pdf.js";
import { sendPushNotification } from "./push.js";
import { reconcile, type Finding } from "./reconcile.js";
import { parseStatement, validateStatement } from "./statement.js";
import {
  applyFix,
  getCutoffDay,
  getDeviceTokens,
  getExpensesSince,
  getPreviousCutoffDate,
  insertFindings,
  insertStatement,
  isStatementProcessed,
  type FindingRecord,
} from "./supabase.js";

const STATEMENT_FROM_ADDRESS = "ekstre@ekstre.yapikredi.com.tr";
// Tam konu "Eylül 2026 TL Worldcard Hesap Özeti" gibi; ay ve yıl değişiyor.
const STATEMENT_SUBJECT = "Hesap Özeti";
// Ekstre ayda bir geliyor; servis birkaç gün çalışmasa bile kaçırmasın diye
// pencere geniş tutuluyor. İşlenmiş mailler tekrar indirilmiyor.
const STATEMENT_NEWER_THAN_DAYS = 40;
// Eşleştirme, kesimden bir ay öncesine kadar olan kayıtlara bakıyor; taksit
// ve dönem sınırı kaymaları için pay bırakılıyor.
const EXPENSE_LOOKBACK_DAYS = 45;

const MONTH_NAMES = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];

/// "2026-09-27" → "Eylül 2026"
function periodLabel(cutoffDate: string): string {
  const [year, month] = cutoffDate.split("-");
  return `${MONTH_NAMES[parseInt(month, 10) - 1]} ${year}`;
}

async function notify(userId: string, title: string, body: string): Promise<void> {
  if (!process.env.APNS_KEY_ID) return;
  try {
    const tokens = await getDeviceTokens(userId);
    await Promise.all(
      tokens.map((token) =>
        sendPushNotification(token, title, body).catch((err) =>
          console.warn(`Push gönderilemedi (${token.slice(0, 8)}…):`, err.message ?? err),
        ),
      ),
    );
  } catch (err) {
    console.warn("Cihaz token'ları okunamadı, push atlanıyor:", err);
  }
}

function describe(finding: Finding): { expenseId: string | null; details: Record<string, unknown> } {
  const details: Record<string, unknown> = {};
  if ("transaction" in finding) details.transaction = finding.transaction;
  if ("cardLast4" in finding) details.cardLast4 = finding.cardLast4;
  if ("expense" in finding) {
    const { cardLast4, merchant, amount, transactionAt } = finding.expense;
    details.expense = { cardLast4, merchant, amount, transactionAt };
  }
  return { expenseId: "expense" in finding ? finding.expense.id : null, details };
}

async function processStatementEmail(email: StatementEmail, userId: string, autoApply: boolean): Promise<void> {
  if (!email.pdf) {
    console.warn(`[ekstre:${email.id}] PDF eki bulunamadı, atlanıyor.`);
    return;
  }

  const statement = parseStatement(await extractPdfLines(email.pdf));
  const problems = validateStatement(statement);
  const cutoffDate = statement.cutoffDate;
  if (!cutoffDate) {
    console.warn(`[ekstre:${email.id}] Ekstre okunamadı, atlanıyor: ${problems.join(" ")}`);
    return;
  }
  const label = periodLabel(cutoffDate);

  // Toplamlar tutmuyorsa ayrıştırma güvenilir değil (banka biçimi değiştirmiş
  // olabilir): tarihler dahil hiçbir şeye güvenilmiyor, sadece bir kez haber
  // veriliyor. Kayıt, aynı mailin her çalıştırmada yeniden denenmemesi için.
  if (problems.length > 0) {
    const statementId = await insertStatement({
      userId,
      messageId: email.id,
      cutoffDate,
      dueDate: null,
      nextCutoffDate: null,
      nextDueDate: null,
      periodDebt: null,
    });
    if (!statementId) return;
    await insertFindings([
      { statementId, userId, kind: "unreadable", expenseId: null, details: { problems }, status: "pending" },
    ]);
    console.warn(`[ekstre:${email.id}] Toplamlar tutmuyor, hiçbir şey değiştirilmedi: ${problems.join(" ")}`);
    await notify(userId, "Ekstre okunamadı", `${label} ekstresinin toplamları tutmadı, kontrol edilemedi.`);
    return;
  }

  const [previousCutoffDate, cutoffDay] = await Promise.all([
    getPreviousCutoffDate(userId, cutoffDate),
    getCutoffDay(userId),
  ]);
  const windowStart = previousCutoffDate ?? cutoffDate;
  const since = new Date(Date.parse(`${windowStart}T00:00:00Z`) - EXPENSE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const expenses: ExpenseRow[] = await getExpensesSince(userId, since.toISOString());

  const findings = reconcile(statement, expenses, { previousCutoffDate: previousCutoffDate ?? undefined });

  // Önce ekstre kaydediliyor: tekil message_id, aynı ekstrenin iki kez
  // işlenip düzeltmelerin iki kez uygulanmasını engelliyor.
  const statementId = await insertStatement({
    userId,
    messageId: email.id,
    cutoffDate,
    dueDate: statement.dueDate,
    nextCutoffDate: statement.nextCutoffDate,
    nextDueDate: statement.nextDueDate,
    periodDebt: statement.periodDebt,
  });
  if (!statementId) {
    console.log(`[ekstre:${email.id}] Zaten işlenmiş, atlandı.`);
    return;
  }

  const records: FindingRecord[] = [];
  let applied = 0;
  for (const finding of findings) {
    const { expenseId, details } = describe(finding);
    const fix = planFix(finding, { statement, cutoffDay });
    let status: FindingRecord["status"] = "pending";
    if (fix) {
      details.fix = fix;
      if (autoApply) {
        await applyFix(userId, fix);
        status = "applied";
        applied++;
      }
    }
    records.push({ statementId, userId, kind: finding.kind, expenseId, details, status });
  }
  await insertFindings(records);

  const pending = findings.length - applied;
  console.log(`[ekstre:${email.id}] ${label}: ${findings.length} bulgu, ${applied} düzeltme, ${pending} bekleyen.`);

  let body: string;
  if (findings.length === 0) {
    body = `${label} ekstresi kayıtlarınla uyuşuyor.`;
  } else if (!autoApply) {
    body = `${label} ekstresinde ${findings.length} fark bulundu. Hiçbir kayıt değiştirilmedi.`;
  } else {
    const parts = [];
    if (applied > 0) parts.push(`${applied} düzeltme yapıldı`);
    if (pending > 0) parts.push(`${pending} kayıt onayını bekliyor`);
    body = `${label} ekstresi: ${parts.join(", ")}.`;
  }
  await notify(userId, "Ekstre kontrol edildi", body);
}

/// Gmail kutusundaki yeni ekstre maillerini işler. Bir ekstre hata verirse
/// diğerleri yine denenir; herhangi biri hata verdiyse true döner.
///
/// `STATEMENT_AUTO_APPLY=true` değilse rapor modunda çalışır: bulgular
/// kaydedilir ve bildirilir ama harcamalara dokunulmaz.
export async function syncStatements(gmailUser: string, appPassword: string, userId: string): Promise<boolean> {
  const autoApply = process.env.STATEMENT_AUTO_APPLY === "true";
  const emails = await fetchStatementEmails(
    gmailUser,
    appPassword,
    STATEMENT_FROM_ADDRESS,
    STATEMENT_SUBJECT,
    STATEMENT_NEWER_THAN_DAYS,
    isStatementProcessed,
  );
  if (emails.length > 0) console.log(`[ekstre] ${emails.length} yeni ekstre maili bulundu.`);

  let hadError = false;
  for (const email of emails) {
    try {
      await processStatementEmail(email, userId, autoApply);
    } catch (err) {
      console.error(`[ekstre:${email.id}] İşlenirken hata oluştu, atlanıyor:`, err);
      hadError = true;
    }
  }
  return hadError;
}
