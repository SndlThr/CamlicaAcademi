// server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const fse = require("fs-extra");
const { execFile } = require("child_process");
const Tesseract = require("tesseract.js");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Upload klasörü
const UPLOAD_DIR = path.join(__dirname, "uploads");
fse.ensureDirSync(UPLOAD_DIR);

// Multer (memory veya disk)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const name = `${Date.now()}-${file.originalname}`.replace(/\s+/g, "_");
    cb(null, name);
  }
});
const upload = multer({ storage });

// sorular.json dosyası
const SORULAR_FILE = path.join(__dirname, "sorular.json");

// Yardımcı: sorular.json oku
function loadSorular() {
  try {
    if (!fs.existsSync(SORULAR_FILE)) {
      fs.writeFileSync(SORULAR_FILE, JSON.stringify({}, null, 2));
    }
    const raw = fs.readFileSync(SORULAR_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    console.error("sorular.json okunamadı:", e);
    return {};
  }
}

// Yardımcı: sorular.json yaz
function saveSorular(obj) {
  try {
    fs.writeFileSync(SORULAR_FILE, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("sorular.json yazılamadı:", e);
    return false;
  }
}

// Başlangıçta yükle
let sorular = loadSorular();

// Basit soru ayıklama heuristiği (metin tabanlı PDF'den)
function parseTextToQuestions(text) {
  // Normalize: satırları birleştir ve soru başlangıçlarına göre böl
  // Soru başı örnekleri: "1)" "1." "1 )"
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const joined = lines.join("\n");

  // Bölme: soru numarası ile başlayan bloklar
  const blocks = joined.split(/\n(?=\s*\d+\s*[\)\.])/g);

  const questions = [];

  for (let block of blocks) {
    // Beklenen format: "1) Soru metni ... A) şık1 B) şık2 C) şık3 D) şık4" veya "1. Soru\nA) şık..."
    const headerMatch = block.match(/^\s*(\d+)\s*[\)\.]\s*(.*)$/s);
    if (!headerMatch) {
      // Eğer blok numarasızsa atla
      continue;
    }
    const id = parseInt(headerMatch[1]);
    const rest = headerMatch[2].trim();

    // Şıkları bulmaya çalış
    // Yaygın: "A) ... B) ... C) ... D) ..." veya "a) b) c) d)" veya "(A) ... "
    // Basit yol: split by "A)" or "B)" etc.
    // Normalize uppercase
    const caps = rest.replace(/\r/g, "");
    // Try split by "A)" etc
    let cevapParts = caps.split(/\n(?=[A-D]\s*[\)\.])|(?=[A-D]\s*[\)\.])/g);

    // If not found, try pattern like "A. "
    if (cevapParts.length === 1) {
      cevapParts = caps.split(/(?=[A-D]\s*\.)/g);
    }

    // If still 1, try find sequences of " - " or ' | ' separators
    if (cevapParts.length === 1) {
      // try split by '|' as last resort
      if (caps.includes("|")) {
        const parts = caps.split("|").map(p => p.trim());
        // assume first part contains question text
        const qtext = parts.shift();
        const answers = parts.slice(0,4);
        questions.push({
          id,
          soru: qtext,
          cevaplar: answers,
          dogruIndex: null,
          puan: null
        });
        continue;
      }
      // else fallback: put entire block as question, no choices
      questions.push({
        id,
        soru: caps,
        cevaplar: [],
        dogruIndex: null,
        puan: null
      });
      continue;
    }

    // Now try to extract question text (before first choice)
    const firstChoiceIdx = caps.search(/[A-D]\s*[\)\.]/);
    let qtext = caps;
    let answers = [];
    if (firstChoiceIdx !== -1) {
      qtext = caps.slice(0, firstChoiceIdx).trim();
      const choicesPart = caps.slice(firstChoiceIdx).trim();

      // Find choices by regex
      const choiceMatches = [...choicesPart.matchAll(/([A-D])\s*[\)\.]?\s*([^A-D]+)/g)];
      if (choiceMatches.length >= 2) {
        answers = choiceMatches.map(m => m[2].trim()).slice(0,4);
      } else {
        // fallback: split by newlines and take up to 4
        answers = choicesPart.split(/\n/).map(s=>s.replace(/^[A-D]\s*[\)\.]?\s*/,'').trim()).filter(Boolean).slice(0,4);
      }
    } else {
      // Fallback earlier splitted parts: use cevapParts array: first is question
      qtext = cevapParts[0].replace(/^[A-D]\s*[\)\.]\s*/,'').trim();
      answers = cevapParts.slice(1).map(s=>s.replace(/^[A-D]\s*[\)\.]\s*/,'').trim()).slice(0,4);
    }

    questions.push({
      id,
      soru: qtext,
      cevaplar: answers,
      dogruIndex: null, // otomatik tespit yok -> admin dolduracak
      puan: null
    });
  }

  // Sort by id to preserve order
  return questions.sort((a,b)=> (a.id||0) - (b.id||0));
}

// PDF -> PNG (pdftoppm) dönüşümü (requires poppler: pdftoppm)
function pdfToPngs(pdfPath, outDir) {
  return new Promise((resolve, reject) => {
    fse.ensureDirSync(outDir);
    const base = path.join(outDir, "page");
    // pdftoppm -png input.pdf outprefix
    const cmd = "pdftoppm";
    const args = ["-png", pdfPath, base];
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        return reject(err);
      }
      // sonuç dosyaları outDir/page-1.png, page-2.png ... veya page-1.png depends
      // Node pdftoppm produces files like base-1.png etc.
      // List files in outDir
      const files = fs.readdirSync(outDir).filter(f => f.endsWith(".png")).map(f => path.join(outDir, f));
      files.sort();
      resolve(files);
    });
  });
}

// OCR bir PNG dosyasından metin çıkarır
async function ocrImageToText(imgPath) {
  try {
    const worker = Tesseract.createWorker({
      // logger: m => console.log(m) // istersen log göster
    });
    await worker.load();
    await worker.loadLanguage("eng"); // ingilizce; türkçe için 'tur'
    await worker.initialize("eng");
    const { data: { text } } = await worker.recognize(imgPath);
    await worker.terminate();
    return text;
  } catch (e) {
    console.error("OCR hatası:", e);
    return "";
  }
}

// Upload PDF endpoint: parse and return candidate questions for admin review
app.post("/upload-pdf", upload.single("pdf"), async (req, res) => {
  try {
    const sinif = req.body.sinif;
    if (!sinif) return res.status(400).json({ error: "Sınıf belirtilmeli" });
    if (!req.file) return res.status(400).json({ error: "PDF dosyası eksik" });

    const pdfPath = req.file.path;

    // 1) Önce pdf-parse ile metin çıkarmayı dene
    const dataBuffer = fs.readFileSync(pdfPath);
    let parsedText = "";
    try {
      const pdfData = await pdfParse(dataBuffer);
      parsedText = pdfData.text || "";
    } catch (e) {
      console.warn("pdf-parse ile metin çıkarılamadı:", e);
      parsedText = "";
    }

    let questions = [];

    if (parsedText && parsedText.trim().length > 50) {
      // Eğer metin yeterliyse doğrudan ayrıştır
      questions = parseTextToQuestions(parsedText);
    } else {
      // Metin yetersiz -> muhtemelen taranmış PDF. Deneyeceğiz: pdftoppm + tesseract
      const outDir = path.join(UPLOAD_DIR, `pages-${Date.now()}`);
      try {
        const pngFiles = await pdfToPngs(pdfPath, outDir);
        let allText = "";
        for (let img of pngFiles) {
          const t = await ocrImageToText(img);
          allText += "\n" + t;
        }
        if (allText.trim().length > 0) {
          questions = parseTextToQuestions(allText);
        } else {
          questions = []; // OCR boş kaldı
        }
      } catch (e) {
        console.warn("PDF->PNG veya OCR aşamasında hata:", e);
        questions = []; // fallback
      }
    }

    // Aşağıda adminin düzenlemesi için JSON döndürüyoruz.
    // Questions array elemanlarında dogruIndex ve puan null olabilir -> admin dolduracak.
    // Ayrıca eğer id eksikse otomatik id atayalım sıra korunacak.
    questions = questions.map((q, idx) => ({
      id: q.id || (idx + 1),
      soru: q.soru || "",
      cevaplar: (q.cevaplar && q.cevaplar.length) ? q.cevaplar : ["", "", "", ""],
      dogruIndex: (typeof q.dogruIndex === "number") ? q.dogruIndex : null,
      puan: (typeof q.puan === "number") ? q.puan : null,
      resim: q.resim || null
    }));

    // Return candidate questions for admin review (not yet saved to sorular.json)
    res.json({
      message: "PDF işlendi — admin onayı bekliyor.",
      sinif,
      parsedCount: questions.length,
      questions
    });
  } catch (e) {
    console.error("upload-pdf hata:", e);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// Admin endpoint: admin onayından sonra soruları kaydet
// Beklenen gövde: { sinif: "5", questions: [ {id, soru, cevaplar, dogruIndex, puan, resim}, ... ] }
app.post("/save-questions", (req, res) => {
  try {
    const { sinif, questions } = req.body;
    if (!sinif || !Array.isArray(questions)) return res.status(400).json({ error: "Geçersiz veri" });

    // ensure order by id
    const ordered = [...questions].sort((a,b)=> (a.id||0)-(b.id||0));

    // Map to expected minimal structure and ensure cevaplar length 4
    const normalized = ordered.map((q, i) => ({
      id: q.id || (i+1),
      soru: q.soru || "",
      cevaplar: (q.cevaplar && q.cevaplar.length) ? q.cevaplar.slice(0,4).concat(Array(4 - (q.cevaplar.length || 0)).fill("")) : ["", "", "", ""],
      dogruIndex: (typeof q.dogruIndex === "number") ? q.dogruIndex : null,
      puan: (typeof q.puan === "number") ? q.puan : null,
      resim: q.resim || null
    }));

    // yükle mevcut sorular yapısına
    sorular[sinif] = normalized;
    const ok = saveSorular(sorular);
    if (!ok) return res.status(500).json({ error: "Sorular dosyaya kaydedilemedi" });

    res.json({ message: `${sinif}. sınıf için ${normalized.length} soru kaydedildi.` });
  } catch (e) {
    console.error("save-questions hata:", e);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});


// GET sorular (öğrenci çeker)
app.get("/sorular/:sinif", (req, res) => {
  const sinif = req.params.sinif;
  if (!sorular[sinif]) return res.status(404).json({ error: "Sınıf için sorular yok" });
  // Return as-is (sıralı)
  res.json(sorular[sinif]);
});

// Puan hesaplama (öğrencinin gönderdiği cevaplara göre)
app.post("/puanla", (req, res) => {
  const { sinif, cevaplar } = req.body;
  if (!sinif || !Array.isArray(cevaplar)) return res.status(400).json({ error: "Geçersiz veri" });
  if (!sorular[sinif]) return res.status(404).json({ error: "Sınıf için sorular yok" });

  let toplam = 0;
  // cevaplar expected: [{ id:1, secilenIndex:0 }, ...]
  for (let c of cevaplar) {
    const s = (sorular[sinif] || []).find(x => x.id === c.id);
    if (s && typeof s.dogruIndex === "number" && s.dogruIndex === c.secilenIndex) {
      toplam += (typeof s.puan === "number") ? s.puan : 0;
    }
  }
  res.json({ toplamPuan: toplam });
});


// Basit kullanıcı kaydı/giriş (önceki)
app.post("/register", (req, res) => {
  const { kadi, sifre, sinif } = req.body;
  if (!kadi || !sifre || !sinif) return res.status(400).json({ error: "Eksik alan" });
  if (ogrenciler.some(o=>o.kadi.toLowerCase()===kadi.toLowerCase())) return res.status(400).json({ error: "Kullanıcı mevcut" });
  ogrenciler.push({ kadi, sifre, sinif, puan:0, role:"ogrenci" });
  res.json({ message: "Kayıt başarılı" });
});

app.post("/login", (req,res) => {
  const { kadi, sifre } = req.body;
  const u = ogrenciler.find(x => x.kadi.toLowerCase()=== (kadi||"").toLowerCase() && x.sifre===sifre);
  if (!u) return res.status(401).json({ error: "Hatalı" });
  const { sifre:_, ...payload } = u;
  res.json(payload);
});


app.get("/", (req,res) => res.send("Backend hazır."));

app.listen(port, ()=> console.log(`Server ${port} portunda ${new Date().toISOString()} çalışıyor`));
