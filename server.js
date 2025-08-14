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

// Eksik değişken tanımı
let ogrenciler = [];

app.use(cors());
app.use(express.json());

// Upload klasörü
const UPLOAD_DIR = path.join(__dirname, "uploads");
fse.ensureDirSync(UPLOAD_DIR);

// Multer ayarları
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

// Basit soru ayıklama heuristiği
function parseTextToQuestions(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const joined = lines.join("\n");
  const blocks = joined.split(/\n(?=\s*\d+\s*[\)\.])/g);
  const questions = [];

  for (let block of blocks) {
    const headerMatch = block.match(/^\s*(\d+)\s*[\)\.]\s*(.*)$/s);
    if (!headerMatch) continue;

    const id = parseInt(headerMatch[1]);
    const rest = headerMatch[2].trim();
    const caps = rest.replace(/\r/g, "");
    let cevapParts = caps.split(/\n(?=[A-D]\s*[\)\.])|(?=[A-D]\s*[\)\.])/g);

    if (cevapParts.length === 1) {
      cevapParts = caps.split(/(?=[A-D]\s*\.)/g);
    }

    if (cevapParts.length === 1) {
      if (caps.includes("|")) {
        const parts = caps.split("|").map(p => p.trim());
        const qtext = parts.shift();
        const answers = parts.slice(0, 4);
        questions.push({ id, soru: qtext, cevaplar: answers, dogruIndex: null, puan: null });
        continue;
      }
      questions.push({ id, soru: caps, cevaplar: [], dogruIndex: null, puan: null });
      continue;
    }

    const firstChoiceIdx = caps.search(/[A-D]\s*[\)\.]/);
    let qtext = caps;
    let answers = [];
    if (firstChoiceIdx !== -1) {
      qtext = caps.slice(0, firstChoiceIdx).trim();
      const choicesPart = caps.slice(firstChoiceIdx).trim();
      const choiceMatches = [...choicesPart.matchAll(/([A-D])\s*[\)\.]?\s*([^A-D]+)/g)];
      if (choiceMatches.length >= 2) {
        answers = choiceMatches.map(m => m[2].trim()).slice(0, 4);
      } else {
        answers = choicesPart.split(/\n/).map(s => s.replace(/^[A-D]\s*[\)\.]?\s*/, "").trim())
          .filter(Boolean).slice(0, 4);
      }
    } else {
      qtext = cevapParts[0].replace(/^[A-D]\s*[\)\.]\s*/, "").trim();
      answers = cevapParts.slice(1).map(s => s.replace(/^[A-D]\s*[\)\.]\s*/, "").trim()).slice(0, 4);
    }

    questions.push({ id, soru: qtext, cevaplar: answers, dogruIndex: null, puan: null });
  }

  return questions.sort((a, b) => (a.id || 0) - (b.id || 0));
}

// PDF -> PNG
function pdfToPngs(pdfPath, outDir) {
  return new Promise((resolve, reject) => {
    try {
      fse.ensureDirSync(outDir);
      const base = path.join(outDir, "page");
      const cmd = "pdftoppm";
      const args = ["-png", pdfPath, base];
      execFile(cmd, args, (err) => {
        if (err) return reject(err);
        const files = fs.readdirSync(outDir).filter(f => f.endsWith(".png"))
          .map(f => path.join(outDir, f));
        files.sort();
        resolve(files);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// OCR PNG -> text
async function ocrImageToText(imgPath) {
  try {
    const worker = Tesseract.createWorker({});
    await worker.load();
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    const { data: { text } } = await worker.recognize(imgPath);
    await worker.terminate();
    return text;
  } catch (e) {
    console.error("OCR hatası:", e);
    return "";
  }
}

// ===================== ROUTES =====================

// Test root (Render “Backend ready” yerine)
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><title>Backend Test</title></head>
      <body style="font-family:sans-serif; text-align:center; padding-top:50px;">
        <h1 style="color:green;">✅ Backend Çalışıyor!</h1>
        <p>Bu mesaj server.js tarafından Render üzerinden gönderildi.</p>
      </body>
    </html>
  `);
});

// Upload PDF
app.post("/upload-pdf", upload.single("pdf"), async (req, res) => {
  try {
    const sinif = req.body.sinif;
    if (!sinif) return res.status(400).json({ error: "Sınıf belirtilmeli" });
    if (!req.file) return res.status(400).json({ error: "PDF dosyası eksik" });

    const pdfPath = req.file.path;
    const dataBuffer = fs.readFileSync(pdfPath);
    let parsedText = "";
    try {
      const pdfData = await pdfParse(dataBuffer);
      parsedText = pdfData.text || "";
    } catch {
      parsedText = "";
    }

    let questions = [];
    if (parsedText && parsedText.trim().length > 50) {
      questions = parseTextToQuestions(parsedText);
    } else {
      try {
        const outDir = path.join(UPLOAD_DIR, `pages-${Date.now()}`);
        const pngFiles = await pdfToPngs(pdfPath, outDir);
        let allText = "";
        for (let img of pngFiles) {
          const t = await ocrImageToText(img);
          allText += "\n" + t;
        }
        if (allText.trim().length > 0) {
          questions = parseTextToQuestions(allText);
        }
      } catch (e) {
        console.warn("PDF->PNG veya OCR hata:", e);
        questions = [];
      }
    }

    questions = questions.map((q, idx) => ({
      id: q.id || (idx + 1),
      soru: q.soru || "",
      cevaplar: (q.cevaplar && q.cevaplar.length) ? q.cevaplar : ["", "", "", ""],
      dogruIndex: typeof q.dogruIndex === "number" ? q.dogruIndex : null,
      puan: typeof q.puan === "number" ? q.puan : null,
      resim: q.resim || null
    }));

    res.json({ message: "PDF işlendi — admin onayı bekliyor.", sinif, parsedCount: questions.length, questions });
  } catch (e) {
    console.error("upload-pdf hata:", e);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// Save questions
app.post("/save-questions", (req, res) => {
  try {
    const { sinif, questions } = req.body;
    if (!sinif || !Array.isArray(questions)) return res.status(400).json({ error: "Geçersiz veri" });

    const ordered = [...questions].sort((a, b) => (a.id || 0) - (b.id || 0));
    const normalized = ordered.map((q, i) => ({
      id: q.id || (i + 1),
      soru: q.soru || "",
      cevaplar: (q.cevaplar && q.cevaplar.length) ? q.cevaplar.slice(0, 4)
        .concat(Array(4 - (q.cevaplar.length || 0)).fill("")) : ["", "", "", ""],
      dogruIndex: typeof q.dogruIndex === "number" ? q.dogruIndex : null,
      puan: typeof q.puan === "number" ? q.puan : null,
      resim: q.resim || null
    }));

    sorular[sinif] = normalized;
    if (!saveSorular(sorular)) return res.status(500).json({ error: "Sorular kaydedilemedi" });

    res.json({ message: `${sinif}. sınıf için ${normalized.length} soru kaydedildi.` });
  } catch (e) {
    console.error("save-questions hata:", e);
    res.status(500).json({ error: "Sunucu hatası" });
  }
});

// Get questions
app.get("/sorular/:sinif", (req, res) => {
  const sinif = req.params.sinif;
  if (!sorular[sinif]) return res.status(404).json({ error: "Sınıf için sorular yok" });
  res.json(sorular[sinif]);
});

// Grade answers
app.post("/puanla", (req, res) => {
  const { sinif, cevaplar } = req.body;
  if (!sinif || !Array.isArray(cevaplar)) return res.status(400).json({ error: "Geçersiz veri" });
  if (!sorular[sinif]) return res.status(404).json({ error: "Sınıf için sorular yok" });

  let toplam = 0;
  for (let c of cevaplar) {
    const s = (sorular[sinif] || []).find(x => x.id === c.id);
    if (s && typeof s.dogruIndex === "number" && s.dogruIndex === c.secilenIndex) {
      toplam += (typeof s.puan === "number") ? s.puan : 0;
    }
  }
  res.json({ toplamPuan: toplam });
});

// Register
app.post("/register", (req, res) => {
  const { kadi, sifre, sinif } = req.body;
  if (!kadi || !sifre || !sinif) return res.status(400).json({ error: "Eksik alan" });
  if (ogrenciler.some(o => o.kadi.toLowerCase() === kadi.toLowerCase())) {
    return res.status(400).json({ error: "Kullanıcı mevcut" });
  }
  ogrenciler.push({ kadi, sifre, sinif, puan: 0, role: "ogrenci" });
  res.json({ message: "Kayıt başarılı" });
});

// Login
app.post("/login", (req, res) => {
  const { kadi, sifre } = req.body;
  const u = ogrenciler.find(x => x.kadi.toLowerCase() === (kadi || "").toLowerCase() && x.sifre === sifre);
  if (!u) return res.status(401).json({ error: "Hatalı" });
  const { sifre: _, ...payload } = u;
  res.json(payload);
});

// Start server
app.listen(port, () => console.log(`Server ${port} portunda çalışıyor`));
