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
): Promise<"inserted" | "duplicate"> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("expenses").insert({
    user_id: process.env.EXPENSE_USER_ID,
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
