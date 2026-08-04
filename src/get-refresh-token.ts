import "dotenv/config";
import http from "node:http";
import open from "open";
import { google } from "googleapis";

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

async function main() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
  });

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, REDIRECT_URI);
      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.end("Yetkilendirme reddedildi, terminale dön.");
        server.close();
        reject(new Error(error));
        return;
      }

      if (authCode) {
        res.end("Giriş tamamlandı, bu sekmeyi kapatabilirsin.");
        server.close();
        resolve(authCode);
      }
    });

    server.listen(PORT, () => {
      console.log("Tarayıcı açılıyor, Google hesabınla giriş yap ve izin ver...");
      open(authUrl);
    });
  });

  const { tokens } = await oauth2Client.getToken(code);
  console.log("\nRefresh token alındı. Bunu .env dosyana veya GitHub Actions secret'ına ekle:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
