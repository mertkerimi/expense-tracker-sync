import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { ExpenseRow, Fix } from "./fixes.js";
import type { ParsedExpense } from "./parser.js";

function getSupabaseClient() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
  );
}

export async function insertExpense(
  gmailMessageId: string,
  expense: ParsedExpense,
  userId: string,
): Promise<"inserted" | "duplicate"> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("expenses").insert({
    user_id: userId,
    gmail_message_id: gmailMessageId,
    card_last4: expense.cardLast4,
    card_type: expense.cardType,
    merchant: expense.merchant,
    amount: expense.amount,
    transaction_at: expense.transactionAt,
    available_limit: expense.availableLimit,
  });

  if (error) {
    // gmail_message_id unique constraint ihlali -> bu e-posta zaten işlenmiş.
    if (error.code === "23505") return "duplicate";
    throw error;
  }

  return "inserted";
}

/// Bir kullanıcının kayıtlı tüm cihaz token'larını döner — birden fazla
/// cihazda oturum açmış olabilir (ör. eski telefon + yeni telefon), her
/// birine ayrı push gönderilir.
export async function getDeviceTokens(userId: string): Promise<string[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("device_tokens")
    .select("device_token")
    .eq("user_id", userId);

  if (error) throw error;
  return (data ?? []).map((row) => row.device_token);
}

/// Bu ekstre maili daha önce işlendi mi? (`statements.message_id` tekil.)
export async function isStatementProcessed(messageId: string): Promise<boolean> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("statements").select("id").eq("message_id", messageId).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/// Verilen kesim tarihinden önceki son ekstrenin kesim tarihi; yoksa null.
export async function getPreviousCutoffDate(userId: string, cutoffDate: string): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("statements")
    .select("cutoff_date")
    .eq("user_id", userId)
    .lt("cutoff_date", cutoffDate)
    .order("cutoff_date", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.cutoff_date ?? null;
}

/// Uygulamanın kullanıcı için kullandığı kesim günü; ayarlanmamışsa
/// uygulamadaki varsayılan (27).
export async function getCutoffDay(userId: string): Promise<number> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("user_settings").select("cutoff_day").eq("user_id", userId).limit(1);
  if (error) throw error;
  return data?.[0]?.cutoff_day ?? 27;
}

/// Kullanıcının verilen andan sonraki silinmemiş harcamaları.
export async function getExpensesSince(userId: string, sinceIso: string): Promise<ExpenseRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("expenses")
    .select("id, gmail_message_id, card_last4, card_type, merchant, amount, transaction_at, category")
    .eq("user_id", userId)
    .eq("is_deleted", false)
    .gte("transaction_at", sinceIso);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    gmailMessageId: row.gmail_message_id,
    cardLast4: row.card_last4,
    cardType: row.card_type,
    merchant: row.merchant,
    amount: Number(row.amount),
    transactionAt: row.transaction_at,
    category: row.category,
  }));
}

export interface StatementRecord {
  userId: string;
  messageId: string;
  cutoffDate: string;
  dueDate: string | null;
  nextCutoffDate: string | null;
  nextDueDate: string | null;
  periodDebt: number | null;
}

/// Ekstreyi kaydeder ve satır id'sini döner. Aynı mail daha önce
/// kaydedilmişse (ör. eşzamanlı ikinci bir çalıştırma) null döner.
export async function insertStatement(record: StatementRecord): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("statements")
    .insert({
      user_id: record.userId,
      message_id: record.messageId,
      cutoff_date: record.cutoffDate,
      due_date: record.dueDate,
      next_cutoff_date: record.nextCutoffDate,
      next_due_date: record.nextDueDate,
      period_debt: record.periodDebt,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return null;
    throw error;
  }
  return data.id;
}

export interface FindingRecord {
  statementId: string;
  userId: string;
  kind: string;
  expenseId: string | null;
  details: unknown;
  status: "pending" | "applied";
}

export async function insertFindings(records: FindingRecord[]): Promise<void> {
  if (records.length === 0) return;
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("statement_findings").insert(
    records.map((record) => ({
      statement_id: record.statementId,
      user_id: record.userId,
      kind: record.kind,
      expense_id: record.expenseId,
      details: record.details,
      status: record.status,
      resolved_at: record.status === "applied" ? new Date().toISOString() : null,
    })),
  );
  if (error) throw error;
}

/// Bir düzeltmeyi veritabanına uygular. Eklenen harcamalar, uygulamada elle
/// eklenenlerle aynı biçimde (`source = 'manual'`, `manual-<UUID>` kimliği)
/// yazılır ki uygulama onları düzenleyip silebilsin.
export async function applyFix(userId: string, fix: Fix): Promise<void> {
  const supabase = getSupabaseClient();

  if (fix.insertExpense) {
    const { error } = await supabase.from("expenses").insert({
      user_id: userId,
      gmail_message_id: `manual-${randomUUID().toUpperCase()}`,
      card_last4: fix.insertExpense.cardLast4,
      card_type: fix.insertExpense.cardType,
      merchant: fix.insertExpense.merchant,
      amount: fix.insertExpense.amount,
      transaction_at: fix.insertExpense.transactionAt,
      source: "manual",
    });
    if (error) throw error;
  }

  if (fix.updateExpense) {
    const { id, ...fields } = fix.updateExpense;
    const { error } = await supabase.from("expenses").update(fields).eq("id", id);
    if (error) throw error;
  }

  if (fix.insertPlan) {
    const { error } = await supabase.from("installment_plans").insert({
      user_id: userId,
      merchant_base: fix.insertPlan.merchantBase,
      total_amount: fix.insertPlan.totalAmount,
      installment_count: fix.insertPlan.installmentCount,
      card_last4: fix.insertPlan.cardLast4,
      card_type: fix.insertPlan.cardType,
      category: fix.insertPlan.category,
      next_due_boundary: fix.insertPlan.nextDueBoundary,
      next_index: fix.insertPlan.nextIndex,
      source_expense_id: fix.insertPlan.sourceExpenseId,
    });
    if (error) throw error;
  }

  if (fix.updatePlanTotal) {
    const { merchantBase, cardLast4, installmentCount, totalAmount } = fix.updatePlanTotal;
    const { error } = await supabase
      .from("installment_plans")
      .update({ total_amount: totalAmount })
      .eq("user_id", userId)
      .eq("merchant_base", merchantBase)
      .eq("card_last4", cardLast4)
      .eq("installment_count", installmentCount);
    if (error) throw error;
  }
}
