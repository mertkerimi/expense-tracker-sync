create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  gmail_message_id text not null unique,
  card_last4 text not null,
  card_type text not null,
  merchant text not null,
  amount numeric(12, 2) not null,
  transaction_at timestamptz not null,
  available_limit numeric(12, 2),
  created_at timestamptz not null default now()
);

create index if not exists expenses_user_id_idx on expenses (user_id);

alter table expenses enable row level security;

-- Backend (service role key) her satırı yazabilir/güncelleyebilir.
create policy "service role full access"
  on expenses
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- iOS uygulaması (anon key + giriş yapmış kullanıcı) sadece kendi satırlarını okuyabilir.
create policy "users read own expenses"
  on expenses
  for select
  using (auth.uid() = user_id);
