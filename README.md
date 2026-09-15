# expense-tracker-sync

Yapı Kredi WorldCard'ın işlem bildirim e-postalarını arka planda okuyup ayrıştıran, [ExpenseTrackerApp](../ExpenseTrackerApp) iOS uygulamasının Supabase veritabanına yazan ve yeni bir harcama geldiğinde kullanıcıya anlık push bildirimi gönderen küçük bir senkronizasyon servisi.

Kullanıcı hiçbir şey yapmıyor: kart ile alışveriş yapılır, banka mail atar, birkaç dakika içinde harcama telefonda görünür.

## Nasıl çalışıyor

```
Gmail (IMAP) / Outlook (Microsoft Graph) — banka bildirim maili
        ▼
   parser.ts  ── e-posta HTML'inden kart no / tutar / tarih / işyeri çıkarır
        ▼
   supabase.ts ── expenses tablosuna yazar (gmail_message_id ile idempotent)
        ▼
   push.ts ── yeni işlem varsa APNs üzerinden telefona push atar
```

İki hesap paralel işlenir:
- **Mert** → Gmail, düz **IMAP + App Password** (`gmail.ts`) — bkz. aşağıdaki not
- **Aylin** → Outlook, **Microsoft Graph OAuth** (`outlook.ts`)

### Neden Gmail tarafı Gmail API/OAuth değil de IMAP kullanıyor?

Google, OAuth consent screen'i **Testing** modundayken verdiği refresh token'ları **7 günde bir otomatik geçersiz kılıyor** — bu da her hafta sync'in sessizce durup GitHub'ın "job failed" maili atmasına sebep oluyordu (git geçmişinde birkaç kez elle düzeltildiği görülebilir). App Password'ler bu süre sınırına tabi değil — kullanıcı elle iptal etmediği sürece süresizler — o yüzden Gmail tarafı düz IMAP'e çevrildi ve sorun kökten çözüldü. Outlook tarafı bu sorunu hiç yaşamadığı için (Microsoft'un token politikası daha gevşek) değiştirilmedi.

Her ikisi de aynı regex tabanlı parser'ı (`parser.ts`) kullanır, çünkü ikisi de aynı bankanın aynı formatlı bildirim mailini alıyor.

### Neden GitHub Actions + Supabase pg_cron birlikte?

Workflow `.github/workflows/sync.yml` içinde tanımlı ve normalde GitHub'ın kendi `schedule:` cron'uyla tetiklenir — ama GitHub, az kullanılan repolarda zamanlanmış workflow'ları **güvenilir şekilde tetiklemiyor** (saatlerce gecikebiliyor). Bunu aşmak için Supabase tarafında bir `pg_cron` job'ı, `pg_net` ile doğrudan GitHub REST API'sine (`workflow_dispatch`) istek atarak workflow'u tetikliyor. Böylece gerçek tetikleme periyodu GitHub'ın taktirine değil, kendi veritabanımıza bağlı.

> **Not:** Bu, aylık ücretsiz Actions dakika kotasını (private repo'da 2000 dk/ay) hızlıca tüketebilir — repo bu yüzden **public**: public repolarda Actions dakikası sınırsız ve ücretsizdir.

## Kurulum

```bash
npm install
cp .env.example .env   # değerleri doldur (aşağıya bak)
npm run dev             # tek seferlik yerel test çalıştırması
```

### Gerekli ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `GMAIL_IMAP_USER` | Mert'in Gmail adresi |
| `GMAIL_APP_PASSWORD` | [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) — hesapta 2FA açık olmalı. Süresiz geçerli, expire olmaz. |
| `EXPENSE_USER_ID` | Mert'in Supabase `auth.users` id'si |
| `MS_CLIENT_ID` / `MS_REFRESH_TOKEN` | Outlook hesabı için Microsoft Graph OAuth bilgileri, `npm run get-token-outlook` ile üretilir |
| `EXPENSE_USER_ID_2` | Aylin'in Supabase `auth.users` id'si |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Service-role erişimiyle `expenses` / `device_tokens` tablolarına yazmak için |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_AUTH_KEY` / `APNS_BUNDLE_ID` | Push bildirimleri için Apple APNs kimlik bilgileri — tanımlı değilse push özelliği sessizce devre dışı kalır |

Yerelde `.env`, GitHub Actions'da repo **Secrets** olarak tutulur; ikisi de aynı isimlerle.

### Script'ler

```bash
npm run dev                # src/index.ts'i doğrudan çalıştır (tsx)
npm run build               # dist/ altına derle
npm start                   # derlenmiş sürümü çalıştır (Actions'ın kullandığı)
npm run get-token-outlook   # Outlook için yeni refresh token al (tarayıcı açar)
npm run typecheck
```

## Veri modeli

`insertExpense`, her e-postayı `gmail_message_id` (Outlook için mesaj id'si) alanına göre `expenses` tablosuna **idempotent** şekilde yazar — aynı e-posta iki kez görülse bile tekrar eklenmez (unique constraint → `duplicate` dönüşü). Silinen işlemler gerçekten silinmez, `is_deleted = true` ile işaretlenir; aksi halde backend aynı maili arama penceresinde tekrar görüp geri eklerdi.

Tam şema için [`supabase/schema.sql`](supabase/schema.sql).

## Bu bir kişisel proje

Bu repo, kod olarak public ama sıfır kişisel/finansal veri içermiyor — gerçek harcama verileri yalnızca Supabase'de, erişimi RLS ile kısıtlı olarak duruyor. Burada olan tek şey e-posta ayrıştırma mantığı ve orkestrasyon kodu.
