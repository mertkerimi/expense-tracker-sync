import crypto from "node:crypto";
import http2 from "node:http2";

// Apple'ın push token'ı doğrulaması için istediği JWT (ES256, "provider
// authentication token") — .p8 anahtarıyla en fazla 1 saat geçerli imzalanır,
// bu yüzden process boyunca tek sefer üretip önbelleğe alıyoruz.
let cachedToken: { jwt: string; issuedAt: number } | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildProviderToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now - cachedToken.issuedAt < 60 * 40) {
    return cachedToken.jwt;
  }

  const keyId = process.env.APNS_KEY_ID!;
  const teamId = process.env.APNS_TEAM_ID!;
  const privateKey = process.env.APNS_AUTH_KEY!.replace(/\\n/g, "\n");

  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat: now }));
  const signingInput = `${header}.${payload}`;

  // Apple'ın .p8 anahtarı ECDSA (P-256) — Node'un imzası DER formatında
  // dönüyor, APNs ise JOSE (r||s, 64 byte ham) formatı bekliyor; ikisi
  // farklı kodlamalar olduğu için dönüştürmemiz gerekiyor.
  const derSignature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  const jwt = `${signingInput}.${base64url(derSignature)}`;
  cachedToken = { jwt, issuedAt: now };
  return jwt;
}

/// Tek bir cihaza push bildirimi gönderir. `deviceToken` geçersizse (ör.
/// kullanıcı uygulamayı kaldırmış) hatayı yutar — bir kullanıcının bozuk
/// token'ı yüzünden tüm senkronu başarısız kılmaya değmez.
export async function sendPushNotification(
  deviceToken: string,
  title: string,
  body: string,
): Promise<void> {
  const bundleId = process.env.APNS_BUNDLE_ID ?? "com.mertkerimi.ExpenseTrackerApp";
  const host = process.env.APNS_HOST ?? "https://api.push.apple.com";
  const jwt = buildProviderToken();

  const client = http2.connect(host);
  client.on("error", () => {});

  try {
    await new Promise<void>((resolve, reject) => {
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      });

      let responseBody = "";
      let status = 0;
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      req.on("data", (chunk) => {
        responseBody += chunk;
      });
      req.on("end", () => {
        if (status >= 200 && status < 300) {
          resolve();
        } else {
          reject(new Error(`APNs ${status}: ${responseBody}`));
        }
      });
      req.on("error", reject);

      req.end(
        JSON.stringify({
          aps: {
            alert: { title, body },
            sound: "default",
          },
        }),
      );
    });
  } finally {
    client.close();
  }
}
