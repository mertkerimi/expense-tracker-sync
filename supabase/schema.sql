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
  created_at timestamptz not null default now(),
  source text not null default 'email' check (source in ('email', 'manual')),
  category text,
  -- Banka mailinden gelen kayıtlar gerçekten silinmiyor (aksi halde backend
  -- aynı gmail_message_id'yi arama penceresinde tekrar görüp geri eklerdi),
  -- bunun yerine bu bayrak true yapılıp uygulamada gizleniyor.
  is_deleted boolean not null default false
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

-- Kullanıcı elle harcama ekleyebilir (source='manual' olmak zorunda).
create policy "users insert own manual expenses"
  on expenses
  for insert
  to authenticated
  with check (auth.uid() = user_id and source = 'manual');

-- Kullanıcı kendi satırlarını güncelleyebilir; e-postadan gelen kayıtlarda
-- hangi alanların değişebileceğini aşağıdaki trigger sınırlıyor (sadece
-- category — RLS satır bazlı, kolon bazlı kısıtlama yapamadığı için).
create policy "users update own expenses"
  on expenses
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users delete own manual expenses"
  on expenses
  for delete
  using (auth.uid() = user_id and source = 'manual');

-- E-postadan gelen (source != 'manual') kayıtlarda category, amount,
-- merchant, card_last4 ve card_type değişebilir (kullanıcı "Hareketler"den
-- bir işlemi açıp neredeyse her alanını düzenleyebiliyor); sadece gerçekten
-- kimliği belirleyen alanlar (tarih, gmail id, limit, kaynak) korunur.
create or replace function protect_synced_expense_fields()
returns trigger as $$
begin
  if old.source != 'manual' then
    if new.transaction_at != old.transaction_at
      or new.gmail_message_id != old.gmail_message_id
      or new.available_limit is distinct from old.available_limit
      or new.source != old.source then
      raise exception 'Cannot modify these synced expense fields: transaction_at, gmail_message_id, available_limit, source';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists protect_synced_expense_fields_trigger on expenses;
create trigger protect_synced_expense_fields_trigger
  before update on expenses
  for each row execute function protect_synced_expense_fields();

-- Taksitli harcamalarda kalan taksitlerin cihazlar arası senkron kalması için.
create table if not exists installment_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  merchant_base text not null,
  total_amount numeric(12, 2) not null,
  installment_count int not null,
  card_last4 text not null,
  card_type text not null,
  category text,
  next_due_boundary timestamptz not null,
  next_index int not null,
  created_at timestamptz not null default now(),
  source_expense_id text
);

alter table installment_plans enable row level security;

create policy "users manage own installment plans"
  on installment_plans
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- "Ödedim" işareti gibi kullanıcıya özel, cihazlar arası kalıcı ayarlar için.
create table if not exists user_settings (
  user_id uuid primary key references auth.users (id),
  paid_period_end timestamptz
);

alter table user_settings enable row level security;

create policy "users manage own settings"
  on user_settings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Kategori başına kullanıcının belirlediği aylık harcama limiti (Bütçe
-- sekmesi). Kategorisi olmayan/limiti hiç ayarlanmamış kategoriler burada
-- satır olarak bulunmaz — uygulama tarafında "limit belirle" CTA'sıyla
-- gösterilir.
create table if not exists category_budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  category text not null,
  monthly_limit numeric(12, 2) not null,
  updated_at timestamptz not null default now(),
  unique (user_id, category)
);

alter table category_budgets enable row level security;

create policy "users manage own category budgets"
  on category_budgets
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
