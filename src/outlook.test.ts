import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSenderAndSubject } from "./outlook.js";

const FROM = "yapikredi@iletisim.yapikredi.com.tr";
const SUBJECT = "Akıllı Asistan Bilgilendirmesi";

test("gönderen ve konu eşleşirse true", () => {
  assert.equal(
    matchesSenderAndSubject(
      { id: "1", subject: `Yapı Kredi ${SUBJECT}`, from: { emailAddress: { address: FROM } } },
      FROM,
      SUBJECT,
    ),
    true,
  );
});

test("gönderen adresinde büyük/küçük harf farkı önemsiz", () => {
  assert.equal(
    matchesSenderAndSubject(
      { id: "1", subject: SUBJECT, from: { emailAddress: { address: FROM.toUpperCase() } } },
      FROM,
      SUBJECT,
    ),
    true,
  );
});

test("başka gönderen veya konu eşleşmez", () => {
  assert.equal(
    matchesSenderAndSubject(
      { id: "1", subject: SUBJECT, from: { emailAddress: { address: "baska@ornek.com" } } },
      FROM,
      SUBJECT,
    ),
    false,
  );
  assert.equal(
    matchesSenderAndSubject(
      { id: "1", subject: "Kampanya duyurusu", from: { emailAddress: { address: FROM } } },
      FROM,
      SUBJECT,
    ),
    false,
  );
});

test("eksik alanlar hata vermez", () => {
  assert.equal(matchesSenderAndSubject({ id: "1" }, FROM, SUBJECT), false);
});
