import "dotenv/config";

// Microsoft'un "device code" akışı: localhost redirect gerekmez, kullanıcı
// sadece ekrandaki kodu microsoft.com/devicelogin adresine girip kendi
// Outlook hesabıyla giriş yapar. Bu script'i kız arkadaşının kendi
// bilgisayarında/telefonunda değil, senin terminalinde çalıştırıp linki ona
// gönderebilirsin — giriş yapan hep o olacağı için refresh token onun hesabı
// için üretilir.

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  error?: string;
}

async function main() {
  const clientId = process.env.MS_CLIENT_ID;
  if (!clientId) {
    throw new Error("MS_CLIENT_ID .env dosyasında tanımlı değil.");
  }

  const deviceCodeRes = await fetch(
    "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        scope: "https://graph.microsoft.com/Mail.Read offline_access",
      }),
    },
  );

  if (!deviceCodeRes.ok) {
    throw new Error(`Device code alınamadı: ${deviceCodeRes.status} ${await deviceCodeRes.text()}`);
  }

  const deviceCode = (await deviceCodeRes.json()) as DeviceCodeResponse;

  console.log("\nAşağıdaki adresi aç ve kodu gir:");
  console.log(`  ${deviceCode.verification_uri}`);
  console.log(`  Kod: ${deviceCode.user_code}\n`);
  console.log("Outlook hesabıyla giriş yapıp izin verdikten sonra buraya otomatik dönülecek...\n");

  const intervalMs = (deviceCode.interval || 5) * 1000;
  const deadline = Date.now() + deviceCode.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const tokenRes = await fetch(
      "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode.device_code,
        }),
      },
    );

    const token = (await tokenRes.json()) as TokenResponse;

    if (token.refresh_token) {
      console.log("Refresh token alındı. Bunu GitHub Actions secret'ına ekle:\n");
      console.log(`MS_REFRESH_TOKEN=${token.refresh_token}`);
      return;
    }

    if (token.error && token.error !== "authorization_pending") {
      throw new Error(`Yetkilendirme hatası: ${token.error}`);
    }
    // "authorization_pending" ise henüz giriş yapılmamış, döngü devam eder.
  }

  throw new Error("Süre doldu, giriş tamamlanmadı. Script'i tekrar çalıştır.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
