import { getDocumentProxy } from "unpdf";

// Aynı satırdaki metin parçaları PDF'te aynı taban çizgisinde duruyor;
// küçük kaymalar (ör. farklı punto) yeni satır sayılmasın diye pay bırakılıyor.
const SAME_LINE_TOLERANCE = 2;

/// PDF'in metnini satır satır döner. Satırlar içerik sırasına göre kurulur:
/// art arda gelen ve aynı yükseklikte duran parçalar tek satırda birleşir.
/// Ekstre ayrıştırıcısı (`statement.ts`) bu satırları bekliyor.
export async function extractPdfLines(data: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(data);
  const lines: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const { items } = await page.getTextContent();

    let current = "";
    let currentY: number | null = null;
    const flush = () => {
      const line = current.replace(/\s+/g, " ").trim();
      if (line) lines.push(line);
      current = "";
    };

    for (const item of items) {
      // İşaretli içerik öğelerinin (`TextMarkedContent`) metni yok.
      if (!("str" in item)) continue;
      const y = item.transform[5];
      if (currentY !== null && Math.abs(y - currentY) > SAME_LINE_TOLERANCE) flush();
      current += item.str;
      currentY = y;
    }
    flush();
  }

  return lines;
}
