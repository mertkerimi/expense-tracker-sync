import { createClient } from "@supabase/supabase-js";
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
