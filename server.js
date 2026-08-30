'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, isWithinOperatingHours } = require('./src/config');
const { createDashboardAuth, isAuthorized } = require('./src/dashboard-auth');
const { ConversationStore } = require('./src/conversation-store');

const config = loadConfig();

// ─── Guard: Unhandled errors ─────────────────────────────────────────────────
process.on('uncaughtException', err => {
  console.error('[FATAL] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', err => console.warn('[GUARD] unhandledRejection:', err?.message || err));

// Patch LocalAuth logout agar tidak crash di Windows (EBUSY)
try {
  const LA = require('whatsapp-web.js/src/authStrategies/LocalAuth');
  const _orig = LA.prototype.logout;
  LA.prototype.logout = async function () {
    try { if (_orig) await _orig.call(this); } catch (_) {}
  };
} catch (_) {}

// ─── Server setup ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = config.port;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  next();
});
app.get('/health', (_req, res) => res.json({
  ok: true,
  whatsapp: currentBotStatus,
  botActive: isBotActive,
  operatingHours: isOperatingHours()
}));
app.use(createDashboardAuth(config.dashboardToken));
app.use(express.static(path.join(__dirname, 'public')));

io.use((socket, next) => {
  if (isAuthorized(socket.handshake.headers, config.dashboardToken)) return next();
  return next(new Error('Akses dashboard ditolak.'));
});

const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const conversationStore = new ConversationStore(path.join(DATA_DIR, 'conversations.json'));

// ─── State ────────────────────────────────────────────────────────────────────
let currentQr          = null;
let currentBotStatus   = 'initializing';
let botAccountInfo     = null;
let isBotActive        = config.botActiveAtStartup;
let filterSavedContact = config.filterSavedContacts;   // true = HANYA balas nomor baru/tidak tersimpan (kontak tersimpan dilewati)
let countIn            = 0;
let countOut           = 0;
const recentLogs       = [];     // max 60 pesan terakhir untuk live monitor rehydration

function isOperatingHours() {
  return isWithinOperatingHours(new Date(), config);
}
function getOpStatus() {
  return {
    inHours: isOperatingHours(),
    isBotActive,
    filterSavedContact,
    filterOnlyNewContacts: filterSavedContact,
    operatingTimeZone: config.operatingTimeZone,
    operatingStartHour: config.operatingStartHour,
    operatingEndHour: config.operatingEndHour,
    countIn,
    countOut
  };
}

// ─── Gemini Key Manager ───────────────────────────────────────────────────────
const KEY_CACHE = path.join(DATA_DIR, 'key_status.json');

function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
}

function loadRawKeys() {
  const set = new Set();
  (process.env.GEMINI_API_KEYS || '').split(',').forEach(k => k.trim() && set.add(k.trim()));
  if (process.env.GEMINI_API_KEY?.trim()) set.add(process.env.GEMINI_API_KEY.trim());
  for (let i = 1; i <= 20; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`]?.trim();
    if (k) set.add(k);
  }
  return [...set];
}

class KeyManager {
  constructor() {
    this.keys = loadRawKeys().map((k, i) => ({
      id: i + 1, key: k,
      okUntil: 0,       // epoch ms: key available after this time (0 = always ok)
      wins: 0, fails: 0
    }));
    this._idx = 0;
    this._loadCache();
    console.log(`[KEYS] ${this.keys.length} Gemini API key dimuat.`);
  }

  _loadCache() {
    try {
      if (!fs.existsSync(KEY_CACHE)) return;
      const data = JSON.parse(fs.readFileSync(KEY_CACHE, 'utf8'));
      const now  = Date.now();
      this.keys.forEach(k => {
        const d = data[keyFingerprint(k.key)];
        if (d?.okUntil > now) {
          k.okUntil = d.okUntil;
          const left = Math.ceil((d.okUntil - now) / 60000);
          console.log(`[KEYS] Key #${k.id} cooldown ${left}m (dari cache).`);
        }
      });
    } catch (_) {}
  }

  _saveCache() {
    try {
      const now = Date.now();
      const data = {};
      this.keys.forEach(k => {
        if (k.okUntil > now) data[keyFingerprint(k.key)] = { okUntil: k.okUntil };
      });
      fs.writeFileSync(KEY_CACHE, JSON.stringify(data, null, 2));
    } catch (_) {}
  }

  // Ambil key yang siap pakai (round-robin)
  next() {
    const now   = Date.now();
    const total = this.keys.length;
    for (let i = 0; i < total; i++) {
      const k = this.keys[(this._idx + i) % total];
      if (k.okUntil <= now) {
        this._idx = (this._idx + i + 1) % total;  // geser untuk berikutnya
        return k;
      }
    }
    return null; // semua dalam cooldown
  }

  // Sukses → tidak perlu apa-apa, idx sudah digeser di next()
  success(k) { k.wins++; }

  // 429 RPM limit (per-menit) → cooldown 70 detik
  rpmLimit(k) {
    k.okUntil = Date.now() + 70_000;
    k.fails++;
    console.warn(`[KEYS] Key #${k.id} RPM limit → cooldown 70s.`);
  }

  // 429/403 Quota habis → cooldown 30 menit
  quotaLimit(k, reason) {
    k.okUntil = Date.now() + 30 * 60_000;
    k.fails++;
    console.warn(`[KEYS] Key #${k.id} QUOTA habis → cooldown 30m. (${reason?.slice(0, 80)})`);
    this._saveCache();
  }

  // 401 Auth Error (Invalid / Expired Token) → cooldown 12 jam
  authError(k, reason) {
    k.okUntil = Date.now() + 12 * 3600_000;
    k.fails++;
    console.warn(`[GEMINI ⚠️] Key #${k.id} (${k.key.slice(0, 8)}...) Invalid/Expired (401) → dinonaktifkan 12 jam.`);
    this._saveCache();
  }

  status() {
    const now = Date.now();
    return this.keys.map(k => ({
      id: k.id,
      short: k.key.slice(0, 8) + '...',
      status: k.okUntil > now ? `wait ${Math.ceil((k.okUntil - now) / 1000)}s` : 'ready',
      wins: k.wins, fails: k.fails
    }));
  }
}

const keys = new KeyManager();

// ─── Gemini multi-model pool caller ──────────────────────────────────────────
const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest'
];

async function callGemini(apiKey, prompt, historyText) {
  const userContent = historyText
    ? `${historyText}\n\nPESAN TERBARU PROSPEK: ${prompt}`
    : `PESAN PROSPEK: ${prompt}`;

  let lastErr = null;

  for (const modelName of GEMINI_MODELS) {
    try {
      const isThinkingModel = modelName.includes('3.7');
      const body = {
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2500,
          ...(isThinkingModel ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              reply_text: { type: 'STRING' },
              trigger_actions: {
                type: 'ARRAY',
                items: { type: 'STRING' }
              }
            },
            required: ['reply_text', 'trigger_actions']
          }
        }
      };

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000)
      });

      if (!res.ok) {
        const e   = await res.json().catch(() => ({}));
        const msg = e?.error?.message || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        err.model  = modelName;

        if (res.status === 401) {
          err.kind = 'auth_error';
          throw err; // Key tidak valid, jangan buang waktu coba model lain
        } else if (res.status === 429) {
          err.kind = /retry|per.?minute|rpm/i.test(msg) ? 'rpm' : 'quota';
          lastErr = err;
          // Coba model Gemini berikutnya yang quota pool-nya terpisah
          continue;
        } else if (res.status === 403) {
          err.kind = 'quota';
          throw err; // Quota project habis menyeluruh
        } else if (res.status === 503 || res.status === 500) {
          err.kind = 'server_busy';
          lastErr = err;
          continue;
        } else {
          err.kind = 'other';
          lastErr = err;
          continue;
        }
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (text) return text;

    } catch (fetchErr) {
      if (fetchErr.kind === 'auth_error' || fetchErr.kind === 'quota') {
        throw fetchErr;
      }
      lastErr = fetchErr;
    }
  }

  throw lastErr || new Error('Semua model Gemini sedang limit.');
}

// ─── DeepSeek (xKiro API) Caller & Key Manager ───────────────────────────────
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.xkiro.com/v1';
const DEEPSEEK_MODEL    = process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-v4-pro';

async function callDeepSeek(apiKey, prompt, historyText) {
  const userContent = historyText
    ? `${historyText}\n\nPESAN TERBARU PROSPEK: ${prompt}`
    : `PESAN PROSPEK: ${prompt}`;

  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.7,
      max_tokens: 1024,
      stream: false
    }),
    signal: AbortSignal.timeout(15_000)
  });

  if (!res.ok) {
    const e    = await res.json().catch(() => ({}));
    const msg  = e?.error?.message || `HTTP ${res.status}`;
    const err  = new Error(msg);
    err.status = res.status;
    err.kind   = res.status === 429 ? 'rpm' : (res.status === 403 ? 'quota' : 'other');
    throw err;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

class DeepSeekKeyManager {
  constructor() {
    this.keys = [];
    (process.env.DEEPSEEK_API_KEYS || '').split(',').forEach(k => k.trim() && this.keys.push({ id: this.keys.length + 1, key: k.trim(), okUntil: 0, wins: 0, fails: 0 }));
    if (process.env.DEEPSEEK_API_KEY?.trim() && !this.keys.some(k => k.key === process.env.DEEPSEEK_API_KEY.trim())) {
      this.keys.push({ id: this.keys.length + 1, key: process.env.DEEPSEEK_API_KEY.trim(), okUntil: 0, wins: 0, fails: 0 });
    }
    for (let i = 1; i <= 10; i++) {
      const k = process.env[`DEEPSEEK_API_KEY_${i}`]?.trim();
      if (k && !this.keys.some(x => x.key === k)) {
        this.keys.push({ id: this.keys.length + 1, key: k, okUntil: 0, wins: 0, fails: 0 });
      }
    }
    this._idx = 0;
    if (this.keys.length > 0) {
      console.log(`[DEEPSEEK] ${this.keys.length} DeepSeek API key dimuat (${DEEPSEEK_MODEL}).`);
    }
  }

  hasKeys() { return this.keys.length > 0; }

  next() {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this._idx + i) % this.keys.length];
      if (k.okUntil <= now) {
        this._idx = (this._idx + i + 1) % this.keys.length;
        return k;
      }
    }
    return null;
  }

  success(k) { k.wins++; }
  rpmLimit(k) {
    k.okUntil = Date.now() + 60_000;
    k.fails++;
    console.warn(`[DEEPSEEK] Key #${k.id} RPM limit → 60s cooldown.`);
  }
}

const deepseekKeys = new DeepSeekKeyManager();

// ─── Groq caller (fallback) ───────────────────────────────────────────────────
const GROQ_MODEL = 'llama-3.3-70b-versatile';

async function callGroq(apiKey, prompt, historyText) {
  const fullPrompt = historyText
    ? `${SYSTEM_PROMPT}\n\n${historyText}\n\nPESAN TERBARU PROSPEK: ${prompt}`
    : `${SYSTEM_PROMPT}\n\nPESAN PROSPEK: ${prompt}`;

  const body = {
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: fullPrompt }],
    temperature: 0.8,
    max_tokens: 600,
    response_format: { type: 'json_object' }  // Groq JSON mode
  };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });

  if (!res.ok) {
    const e    = await res.json().catch(() => ({}));
    const msg  = e?.error?.message || `HTTP ${res.status}`;
    const err  = new Error(msg);
    err.status = res.status;
    err.kind   = res.status === 429 ? 'rpm' : 'other';
    throw err;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ─── Groq Key Manager ─────────────────────────────────────────────────────────
class GroqKeyManager {
  constructor() {
    this.keys = [];
    // Support multiple Groq keys: GROQ_API_KEY, GROQ_API_KEY_1, GROQ_API_KEY_2, ...
    const single = process.env.GROQ_API_KEY?.trim();
    if (single) this.keys.push({ id: 1, key: single, okUntil: 0, wins: 0, fails: 0 });
    for (let i = 1; i <= 10; i++) {
      const k = process.env[`GROQ_API_KEY_${i}`]?.trim();
      if (k) this.keys.push({ id: this.keys.length + 1, key: k, okUntil: 0, wins: 0, fails: 0 });
    }
    this._idx = 0;
    if (this.keys.length > 0) {
      console.log(`[GROQ] ${this.keys.length} Groq API key dimuat.`);
    }
  }

  hasKeys() { return this.keys.length > 0; }

  next() {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this._idx + i) % this.keys.length];
      if (k.okUntil <= now) {
        this._idx = (this._idx + i + 1) % this.keys.length;
        return k;
      }
    }
    return null;
  }

  success(k) { k.wins++; }
  rpmLimit(k) {
    k.okUntil = Date.now() + 65_000;
    k.fails++;
    console.warn(`[GROQ] Key #${k.id} RPM limit → 65s cooldown.`);
  }
}

const groqKeys = new GroqKeyManager();

// ─── Robust JSON extractor ────────────────────────────────────────────────────
const VALID_TRIGGERS = new Set([
  'PL_PK14','PL_PK15','PL_PK16','PL_PK17','PL_PK18',
  'VIDEO_PK14','VIDEO_PK15','VIDEO_PK16','VIDEO_PK17','VIDEO_PK18',
  'MAPS_PK14','MAPS_PK15','MAPS_PK16','MAPS_PK17','MAPS_PK18'
]);

function parseAIResponse(raw) {
  if (!raw || raw.trim().length < 5) return null;

  // Bersihkan markdown code block kalau ada
  const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();

  // Cari JSON object
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');

  if (start !== -1 && end > start) {
    try {
      const obj   = JSON.parse(cleaned.slice(start, end + 1));
      const reply = obj?.reply_text;

      // reply_text harus string nyata, bukan instruksi sistem
      if (
        typeof reply === 'string' &&
        reply.trim().length > 3 &&
        !reply.startsWith('response:') &&
        !reply.startsWith('Be honest') &&
        !reply.includes('System:') &&
        !reply.includes('{{')
      ) {
        // Support kedua format: trigger_actions (array baru) atau trigger_action (string lama)
        let triggers = [];
        if (Array.isArray(obj.trigger_actions)) {
          triggers = obj.trigger_actions.filter(t => VALID_TRIGGERS.has(t));
        } else if (typeof obj.trigger_action === 'string' && VALID_TRIGGERS.has(obj.trigger_action)) {
          triggers = [obj.trigger_action];
        }

        return {
          reply_text:      reply.trim(),
          trigger_actions: triggers   // selalu array, bisa []
        };
      }
    } catch (_) {}
  }

  // Fallback regex jika JSON terpotong tanpa penutup
  const match = cleaned.match(/"reply_text"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)/i);
  if (match && match[1] && match[1].trim().length > 5) {
    let reply = match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, ' ')
      .trim();

    for (const t of VALID_TRIGGERS) {
      reply = reply.replace(new RegExp(`\\[?${t}\\]?`, 'g'), '').trim();
    }

    return {
      reply_text: reply,
      trigger_actions: []
    };
  }

  return null;
}


// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Kamu adalah Ariel, Senior Property Consultant resmi dari Pesona Kahuripan Group.
Kepribadian: Ramah, santai, solutif, natural seperti orang WA-an asli (bukan bot kaku). Pakai sapaan akrab "Kak/Mas/Mbak" dan emoji natural (😊🏡✨🚗📋🙏).

═══════════════════════════════════════════════════════════════════════════════
⭐ ATURAN UTAMA GAYA KOMUNIKASI (WAJIB DIIKUTI!):
═══════════════════════════════════════════════════════════════════════════════
1. PANJANG CHAT: Cukup 2-4 kalimat santai & padat (maksimal 35-50 kata).
2. DILARANG membuat essay panjang, daftar berpoin tebal (**1.**, **2.**), atau penjelasan over yang kaku!
3. ALUR PERCAKAPAN KONSULTATIF:
   - Jawab pertanyaan prospek secara to-the-point & santai (1-2 kalimat).
   - JIKA PROSPEK TANYA DAERAH UMUM YANG PUNYA BANYAK PILIHAN (misal: Bogor): Sebutkan dulu pilihannya secara singkat, lalu TANYAKAN MINATNYA DULU ("Kakak lebih minat yang dekat KRL, yang siap huni, atau dekat Cibubur nih? Biar Ariel kirimin brosur yang pas 😊").
   - JANGAN LANGSUNG KIRIM BANYAK BROSUR SEKALIGUS!

═══════════════════════════════════════════════════════════════════════════════
⚡ ATURAN PENGIRIMAN MEDIA & ANTI-SPAM (SANGAT KETAT!):
═══════════════════════════════════════════════════════════════════════════════
- JANGAN kirim media jika prospek BELUM MEMINTA! (trigger_actions: []).
- DILARANG MENGIRIM LEBIH DARI 1 BROSUR PL SEKALIGUS! trigger_actions maksimal hanya 1 proyek (misal: ["PL_PK16"]).
- DILARANG MENAWARKAN ULANG BROSUR/PL JIKA SUDAH PERNAH DIKIRIM!
  * Periksa riwayat chat dan catatan media terkirim. Jika brosur untuk proyek tersebut sudah dikirim sebelumnya, JANGAN tawarkan kirim brosur lagi!
  * Alihkan ke pertanyaan berikutnya: tanyakan ada yang mau ditanyakan dari brosur, tanyakan rencana tenor cicilan, atau ajak survei lokasi.
- FORMAT TRIGGER RESMI (WAJIB PERSIS):
  * Brosur/Pricelist: PL_PK14, PL_PK15, PL_PK16, PL_PK17, PL_PK18
  * Video: VIDEO_PK14, VIDEO_PK15, VIDEO_PK16, VIDEO_PK17, VIDEO_PK18
  * Maps: MAPS_PK14, MAPS_PK15, MAPS_PK16, MAPS_PK17, MAPS_PK18
- Saat kirim media, reply_text HANYA 1 kalimat pengantar singkat (contoh: "Siap Kak! Ini brosur resmi PK16 yaa 📋✨").

═══════════════════════════════════════════════════════════════════════════════
🏠 KNOWLEDGE BASE 5 PERUMAHAN SUBSIDI PESONA KAHURIPAN (TIPE 30/60):
═══════════════════════════════════════════════════════════════════════════════
1. PK14 (Cileungsi Bogor Timur): Dekat Cibubur & Jl. Raya Cileungsi-Jonggol. Harga Rp 185 Juta, All-in Rp 7 Jt (Booking promo Rp 500rb). Rek: Bank BTN 0013 0013 0000 1880 (PT Hikmah Alam Sentosa).
2. PK15 (Cileungsi Mega Township): Kawasan township mandiri >1.100 unit, Masjid Al Qahhaar. Harga Rp 185 Juta, All-in Rp 7 Jt (Booking promo Rp 500rb). Rek: Bank BTN 0013 0013 0000 1880 (PT Hikmah Alam Sentosa).
3. PK16 (Klapanunggal Bogor): Keunggulan: SUDAH ADA UNIT READY STOCK (SIAP HUNI), asri & sejuk dekat Cibinong/Cileungsi. Harga Rp 185 Juta, All-in Rp 7 Jt (Booking promo Rp 500rb). Rek: Bank BTN 00131-01-30-000191-5 (PT Hikmah Alam Sentosa).
4. PK17 (Kasemen Kota Serang Banten): Harga Rp 166 Juta. PROMO SUPER: ALL-IN CUMA Rp 500.000 sampai terima kunci (Free DP, BPHTB, Notaris, Admin). Rek: Bank BTN 1501 3000 16302 (JO PT TMR - PT HAS).
5. PK18 (Parung Panjang Bogor): 10 Menit Stasiun KRL Parung Panjang (direct Tanah Abang/Sudirman), ADA CARPORT 1 MOBIL. Harga Rp 185 Juta, All-in Rp 7 Jt (Booking promo Rp 500rb). Rek: Bank BTN 004 77013 0000 1193 (PT Hikmah Alam Sentosa).

🎯 REKOMENDASI LOKASI:
- Jakarta (Pusat/Barat/Selatan/Sudirman) / Tangerang / BSD via KRL -> Rekomendasikan PK18 Parung Panjang (10 menit ke KRL direct Tanah Abang, ada Carport).
- Jakarta Timur / Cibubur / Bekasi / Cileungsi -> Rekomendasikan PK14 atau PK15 Cileungsi.
- Bogor / Depok / Cibinong / Butuh Siap Huni -> Rekomendasikan PK16 Klapanunggal (ada unit siap huni) atau PK14/15.
- Serang / Cilegon / Banten / Merak -> Rekomendasikan PK17 Serang (All-In cuma Rp 500rb).
- Jika prospek sudah sebut project tertentu: Langsung layani project tersebut!

💳 PROSEDUR BOOKING:
- Jika minta nomor rekening / booking: Berikan nomor rekening Bank BTN resmi di atas sesuai proyek, jelaskan Booking Fee promo cuma Rp 500.000, dan minta kirim bukti transfer ke chat untuk kunci unit.

📑 KPR & SERTIFIKAT:
- KPR Subsidi = SHGB (Murni/Pecah); Cash = SHM. (Jangan sebut SHM untuk KPR Subsidi!).
- Angsuran KPR BTN Flat: 10 th: ~1,9 jt | 15 th: ~1,4 jt | 20 th: ~1,1 jt/bln (Khusus PK17 Serang: 15 th ~1,2 jt, 20 th ~1,07 jt/bln).
- Syarat KPR: Usia 21-45 th, karyawan tetap/kontrak Jabodetabek/Banten, BI Checking/SLIK bersih.

OUTPUT HARUS FORMAT JSON MURNI:
{"reply_text": "...", "trigger_actions": []}`;

// ─── Conversation history (30 turns buffer + Media tracking) ───────────────────
const histories = new Map();   // sender → [{role, text, triggers: []}]
const historyActivity = new Map();

// Pulihkan konteks setiap nomor dari penyimpanan agar restart tidak mencampur
// atau menghilangkan arah percakapan prospek.
for (const summary of conversationStore.list()) {
  const conversation = conversationStore.get(summary.id);
  const restored = conversation.messages.slice(-30).map(message => ({
    role: message.direction === 'in' ? 'user' : 'assistant',
    text: message.body,
    triggers: Array.isArray(message.triggers) ? message.triggers : []
  }));
  if (restored.length > 0) {
    histories.set(summary.id, restored);
    historyActivity.set(summary.id, Date.parse(summary.lastMessageAt) || Date.now());
  }
}

function getHistory(sender) {
  if (!histories.has(sender)) histories.set(sender, []);
  return histories.get(sender);
}

function pushHistory(sender, role, text, triggers = []) {
  const h = getHistory(sender);
  h.push({ role, text, triggers: Array.isArray(triggers) ? triggers : [] });
  historyActivity.set(sender, Date.now());
  if (h.length > 30) h.shift();   // memori hingga 30 percakapan
}

// Hindari memori terus bertambah jika bot menerima banyak nomor berbeda.
setInterval(() => {
  const expiredBefore = Date.now() - config.historyTtlMs;
  for (const [sender, lastActivity] of historyActivity) {
    if (lastActivity < expiredBefore && !userStates.has(sender)) {
      histories.delete(sender);
      historyActivity.delete(sender);
    }
  }
  for (const [key, sentAt] of sentMaps) {
    if (sentAt < expiredBefore) sentMaps.delete(key);
  }
}, Math.min(config.historyTtlMs, 60 * 60_000)).unref();

function buildHistoryText(sender) {
  const h = getHistory(sender);
  if (!h.length) return '';

  const sentSet = new Set();
  h.forEach(item => {
    if (item.triggers && item.triggers.length > 0) {
      item.triggers.forEach(t => sentSet.add(t));
    }
  });

  let mediaHeader = '';
  if (sentSet.size > 0) {
    mediaHeader = `[CATATAN SISTEM: Media yang SUDAH PERNAH DIKIRIM ke prospek ini: ${Array.from(sentSet).join(', ')}. DILARANG MENAWARKAN / MENGIRIM ULANG media-media tersebut kecuali prospek meminta eksplisit!]\n\n`;
  }

  const chatLines = h.map(x => {
    if (x.role === 'user') {
      return `Prospek: "${x.text}"`;
    } else {
      const mediaTag = (x.triggers && x.triggers.length > 0) ? ` [MEDIA TERKIRIM: ${x.triggers.join(', ')}]` : '';
      return `Ariel: "${x.text}"${mediaTag}`;
    }
  }).join('\n');

  return mediaHeader + 'RIWAYAT PERCAKAPAN LENGKAP:\n' + chatLines;
}

function hydrateHistoryFromStore(sender, currentMessage) {
  if (histories.get(sender)?.length) return;
  const conversation = conversationStore.get(sender);
  if (!conversation?.messages?.length) return;

  const messages = conversation.messages.slice(-30);
  const latest = messages[messages.length - 1];
  if (latest?.direction === 'in' && latest.body === currentMessage) messages.pop();
  if (!messages.length) return;

  histories.set(sender, messages.map(message => ({
    role: message.direction === 'in' ? 'user' : 'assistant',
    text: message.body,
    triggers: Array.isArray(message.triggers) ? message.triggers : []
  })));
  historyActivity.set(sender, Date.now());
}

// ─── Profanity & cold responses ───────────────────────────────────────────────
const PROFANITY = [
  /\b(ngentot|kontol|memek|jembut|peler|pepek|toket|tetek|kimak|puki)\b/i,
  /\b(anjing|anjir|babi|bangsat|bajingan|kampret|brengsek)\b/i,
  /\b(goblok|goblog|tolol|bego|idiot|lonte|pelacur|sundal)\b/i,
  /\b(jancok|jancuk|asu|matamu|bacot)\b/i,
  /\b(fuck|shit|bitch|bastard|asshole|cunt|dick)\b/i
];
const COLD = [
  'Ariel siap bantu kalau kita ngobrol dengan bahasa yang baik ya, Kak 🙏 Ada info rumah yang ingin ditanyakan?',
  'Yuk kita lanjut dengan bahasa yang sopan, Kak 😊 Ariel siap bantu soal lokasi, harga, atau KPR.',
  'Ariel tetap siap membantu, Kak. Mohon gunakan bahasa yang baik agar konsultasinya nyaman ya 🙏'
];
const hasProfanity = t => PROFANITY.some(r => r.test(t));
const coldReply    = () => COLD[Math.floor(Math.random() * COLD.length)];

// ─── Explicit trigger detector ────────────────────────────────────────────────
function detectTriggers(msg, sender) {
  const m = msg.toLowerCase();

  // 1. Cari project yang disebutkan langsung di pesan sekarang
  let pk = null;
  if      (/pk\s*14|pesona kahuripan 14/i.test(m)) pk = 'PK14';
  else if (/pk\s*15|pesona kahuripan 15/i.test(m)) pk = 'PK15';
  else if (/pk\s*16|pesona kahuripan 16/i.test(m)) pk = 'PK16';
  else if (/pk\s*17|pesona kahuripan 17/i.test(m)) pk = 'PK17';
  else if (/pk\s*18|pesona kahuripan 18/i.test(m)) pk = 'PK18';

  // 2. Jika tidak ada di pesan sekarang, cari di history (tapi hanya jika history merujuk 1 project spesifik)
  if (!pk) {
    const h = getHistory(sender);
    for (let i = h.length - 1; i >= 0; i--) {
      const t = h[i].text.toLowerCase();
      const countPK = (t.match(/pk\s*1[4-8]/gi) || []).length;
      if (countPK === 1) {
        if (/pk\s*14|pesona kahuripan 14/.test(t))     { pk = 'PK14'; break; }
        if (/pk\s*15|pesona kahuripan 15/.test(t))     { pk = 'PK15'; break; }
        if (/pk\s*16|pesona kahuripan 16/.test(t))     { pk = 'PK16'; break; }
        if (/pk\s*17|pesona kahuripan 17/.test(t))     { pk = 'PK17'; break; }
        if (/pk\s*18|pesona kahuripan 18/.test(t))     { pk = 'PK18'; break; }
      }
    }
  }

  if (!pk) return [];

  // Cek apakah bot sebelumnya menawarkan & user setuju
  const lastBot    = [...getHistory(sender)].reverse().find(x => x.role === 'assistant')?.text?.toLowerCase() || '';
  const offeredPL  = /brosur|pricelist|pl\b/i.test(lastBot);
  const offeredVid = /video/i.test(lastBot);

  // Hanya anggap setuju jika jawaban pendek dan bukan membahas topik lain (booking, rekening, transfer, dll)
  const isDiscussingOther = /booking|rekening|transfer|bayar|tf|angsuran|cicil|syarat|gaji|lokasi|harga|dp/i.test(m);
  const agreed     = !isDiscussingOther && (
    /^(boleh|iya|ya|mau|siap|oke|ok|kirim|dong|keduanya|semua|mau dong|boleh dong|kirim dong)[.!]?$/i.test(m.trim()) ||
    (/\b(boleh|mau|kirim|oke)\b/i.test(m) && m.length < 35)
  );

  const wantPL  = /\b(pl|pricelist|brosur|daftar harga|foto pl)\b/i.test(m) || (offeredPL && agreed);
  const wantVid = /\b(video|videonya)\b/i.test(m) || (offeredVid && agreed);
  const wantMap = /\b(sharelok|maps|titik lokasi|share loc)\b/i.test(m);

  const triggers = [];
  if (wantPL)  triggers.push(`PL_${pk}`);
  if (wantVid) triggers.push(`VIDEO_${pk}`);
  if (wantMap) triggers.push(`MAPS_${pk}`);

  return triggers;
}

// ─── Trigger Sanitizer & Anti-Spam Guard ───────────────────────────────────────
function sanitizeTriggers(triggers, sender, userMsg) {
  if (!Array.isArray(triggers) || triggers.length === 0) return [];

  // 1. Validasi trigger
  const valid = triggers.filter(t => VALID_TRIGGERS.has(t));
  if (valid.length === 0) return [];

  // 2. Cegah spam banyak project: Ambil HANYA 1 project pertama
  const firstPK = valid[0].replace(/^(PL|VIDEO|MAPS)_/, '');
  const singleProjectTriggers = valid.filter(t => t.endsWith(`_${firstPK}`));

  // 3. Batasi maksimal 2 media per pengiriman (misal PL + VIDEO)
  const limited = singleProjectTriggers.slice(0, 2);

  // 4. Cek apakah media ini sudah pernah dikirim ke prospek di riwayat chat
  const h = getHistory(sender);
  const alreadySent = new Set();
  h.forEach(item => {
    if (item.triggers) item.triggers.forEach(t => alreadySent.add(t));
  });

  const forceResend = /kirim ulang|minta lagi|sharelok lagi|maps lagi|brosur lagi|kirim lagi/i.test(userMsg);

  const finalTriggers = limited.filter(t => {
    if (alreadySent.has(t) && !forceResend) {
      console.log(`[GUARD 🛡️] ${t} sudah pernah dikirim ke ${sender}, di-skip agar tidak dobel/spam.`);
      return false;
    }
    return true;
  });

  return finalTriggers;
}

// ─── Reply sanitizer ──────────────────────────────────────────────────────────
const META = {
  PK14: { name: 'Pesona Kahuripan 14', area: 'Cileungsi Bogor',         harga: 'Rp 185 Juta' },
  PK15: { name: 'Pesona Kahuripan 15', area: 'Cileungsi Mega Township',  harga: 'Rp 185 Juta' },
  PK16: { name: 'Pesona Kahuripan 16', area: 'Klapanunggal Bogor',       harga: 'Rp 185 Juta' },
  PK17: { name: 'Pesona Kahuripan 17', area: 'Kasemen Kota Serang',      harga: 'All-in Rp 500rb' },
  PK18: { name: 'Pesona Kahuripan 18', area: 'Parung Panjang dekat KRL', harga: 'Rp 185 Juta' }
};

// triggers: array of trigger strings (may be empty [])
function safeReply(text, triggers) {
  if (!text) return defaultReply(triggers);

  // Strip prompt leaks
  let t = text
    .replace(/\s*\([^)]*(?:sistem|backend|ralat|melampirkan)[^)]*\)/gi, '')
    .replace(/\b(?:sistem backend|ralat|melampirkan file)[^.\n]*/gi, '')
    .trim();

  const leaked = /trigger_action|trigger_actions|sistem backend|mendapatkan PL|mengirimkan pesan/.test(t);
  if (leaked) return defaultReply(triggers);

  return t || defaultReply(triggers);
}

function defaultReply(triggers) {
  if (!triggers || triggers.length === 0) return 'Halo Kak! 😊 Ada yang bisa Ariel bantu seputar info rumah Pesona Kahuripan?';
  const first = triggers[0];
  const pk    = first.replace(/^(PL|VIDEO|MAPS)_/, '');
  const meta  = META[pk] || { name: 'Pesona Kahuripan' };
  const hasPL  = triggers.some(t => t.startsWith('PL_'));
  const hasVid = triggers.some(t => t.startsWith('VIDEO_'));
  const hasMp  = triggers.some(t => t.startsWith('MAPS_'));
  if (hasPL && hasVid) return `Siap Kak! Ini video dan brosur ${meta.name} ya 🏡📋✨`;
  if (hasPL)  return `Siap Kak! Ini pricelist resmi ${meta.name} ya 📋✨`;
  if (hasVid) return `Ini video ${meta.name} Kak, asri banget! 🏡✨`;
  if (hasMp)  return `Ini titik lokasi ${meta.name} Kak 🚗📍`;
  return 'Siap Kak! Ada yang bisa Ariel bantu? 😊';
}

// ─── Query AI (main function) ─────────────────────────────────────────────────
async function queryAI(message, sender) {
  hydrateHistoryFromStore(sender, message);

  // 1. Profanity filter
  if (hasProfanity(message)) {
    const r = coldReply();
    pushHistory(sender, 'user', message);
    pushHistory(sender, 'assistant', r, []);
    return { reply_text: r, trigger_actions: [] };
  }

  // 2. Explicit trigger detection (array)
  const explicitTriggers = detectTriggers(message, sender);

  // 3. Try Gemini keys
  const histText = buildHistoryText(sender);
  const total    = keys.keys.length;

  for (let attempt = 0; attempt < total; attempt++) {
    const k = keys.next();
    if (!k) {
      console.warn('[AI] Semua key cooldown, pakai fallback.');
      break;
    }

    try {
      const raw    = await callGemini(k.key, message, histText);
      const parsed = parseAIResponse(raw);
      keys.success(k);

      if (!parsed) {
        console.warn(`[AI] Key #${k.id} respon tidak valid JSON. Raw: "${raw?.slice(0, 80)}"`);
        const cleanTriggers = sanitizeTriggers(explicitTriggers, sender, message);
        const fallbackText = cleanTriggers.length > 0
          ? defaultReply(cleanTriggers)
          : 'Halo Kak! 😊 Ada yang bisa Ariel bantu seputar rumah Pesona Kahuripan?';
        const result = { reply_text: fallbackText, trigger_actions: cleanTriggers };
        pushHistory(sender, 'user', message);
        pushHistory(sender, 'assistant', result.reply_text, result.trigger_actions);
        return result;
      }

      console.log(`[AI ✅] Key #${k.id} OK.`);

      // Jika explicit triggers ada tapi AI tidak hasilkan trigger → pakai explicit
      if (explicitTriggers.length > 0 && parsed.trigger_actions.length === 0) {
        console.log(`[AI] Explicit trigger override: ${explicitTriggers.join(',')}`);
        parsed.trigger_actions = explicitTriggers;
      }

      parsed.trigger_actions = sanitizeTriggers(parsed.trigger_actions, sender, message);
      parsed.reply_text = safeReply(parsed.reply_text, parsed.trigger_actions);
      pushHistory(sender, 'user', message);
      pushHistory(sender, 'assistant', parsed.reply_text, parsed.trigger_actions);
      return parsed;

    } catch (err) {
      const kind = err.kind || 'other';
      if (kind === 'auth_error') {
        keys.authError(k, err.message);
      } else if (kind === 'rpm') {
        keys.rpmLimit(k);
      } else if (kind === 'quota') {
        keys.quotaLimit(k, err.message);
      } else {
        keys.rpmLimit(k);
        console.warn(`[AI] Key #${k.id} error [${err.status || 'timeout'}]: ${err.message?.slice(0, 80)}`);
      }
    }
  }

  // 4. DeepSeek (xKiro API) fallback
  if (deepseekKeys.hasKeys()) {
    const dk = deepseekKeys.next();
    if (dk) {
      try {
        const raw    = await callDeepSeek(dk.key, message, histText);
        const parsed = parseAIResponse(raw);
        deepseekKeys.success(dk);
        console.log(`[DEEPSEEK ✅] Key #${dk.id} OK.`);

        if (parsed) {
          if (explicitTriggers.length > 0 && parsed.trigger_actions.length === 0) {
            parsed.trigger_actions = explicitTriggers;
          }
          parsed.trigger_actions = sanitizeTriggers(parsed.trigger_actions, sender, message);
          parsed.reply_text = safeReply(parsed.reply_text, parsed.trigger_actions);
          pushHistory(sender, 'user', message);
          pushHistory(sender, 'assistant', parsed.reply_text, parsed.trigger_actions);
          return parsed;
        }
      } catch (err) {
        deepseekKeys.rpmLimit(dk);
        console.warn(`[DEEPSEEK] Error: ${err.message?.slice(0, 80)}`);
      }
    }
  }

  // 5. Groq fallback (jika Gemini & DeepSeek habis/limit)
  if (groqKeys.hasKeys()) {
    const gk = groqKeys.next();
    if (gk) {
      try {
        const raw    = await callGroq(gk.key, message, histText);
        const parsed = parseAIResponse(raw);
        groqKeys.success(gk);
        console.log(`[GROQ ✅] Key #${gk.id} OK.`);

        if (parsed) {
          if (explicitTriggers.length > 0 && parsed.trigger_actions.length === 0) {
            parsed.trigger_actions = explicitTriggers;
          }
          parsed.trigger_actions = sanitizeTriggers(parsed.trigger_actions, sender, message);
          parsed.reply_text = safeReply(parsed.reply_text, parsed.trigger_actions);
          pushHistory(sender, 'user', message);
          pushHistory(sender, 'assistant', parsed.reply_text, parsed.trigger_actions);
          return parsed;
        }
      } catch (err) {
        groqKeys.rpmLimit(gk);
        console.warn(`[GROQ] Error: ${err.message?.slice(0, 80)}`);
      }
    }
  }

  // 6. Final fallback (semua provider habis)
  const cleanTriggers = sanitizeTriggers(explicitTriggers, sender, message);
  const fallbackText = cleanTriggers.length > 0
    ? defaultReply(cleanTriggers)
    : 'Halo Kak! 😊 Maaf sedikit terlambat. Ada yang bisa Ariel bantu seputar rumah Pesona Kahuripan?';
  const result = { reply_text: fallbackText, trigger_actions: cleanTriggers };
  pushHistory(sender, 'user', message);
  pushHistory(sender, 'assistant', result.reply_text, result.trigger_actions);
  return result;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Media sender ─────────────────────────────────────────────────────────────
const MAPS_FILES  = { PK14:'mapspk14.txt',   PK15:'mapspk15.txt',   PK16:'mapspk16.txt',   PK17:'mapspk17.txt',   PK18:'mapspk18.txt'   };
const VIDEO_FILES = { PK14:'video_pk14.mp4', PK15:'video_pk15.mp4', PK16:'video_pk16.mp4', PK17:'video_pk17.mp4', PK18:'video_pk18.mp4' };
const PL_FILES    = { PK14:'PL_PK14.jpg',    PK15:'PL_PK15.jpg',    PK16:'PL_PK16.jpg',    PK17:'PL_PK17.jpg',    PK18:'PL_PK18.jpg'    };

// Anti-spam maps: jangan kirim duplikat lokasi kecuali diminta ulang
const sentMaps = new Map();

async function sendMedia(client, chatId, trigger, userMsg) {
  const m = trigger.match(/^(PL|VIDEO|MAPS)_(PK1[4-8])$/);
  if (!m) return;
  const [, type, pk] = m;
  const meta = META[pk];

  if (type === 'MAPS') {
    const key = `${chatId}:${trigger}`;
    const forceResend = /kirim ulang|minta lagi|sharelok lagi|maps lagi/i.test(userMsg);
    if (sentMaps.has(key) && !forceResend) {
      console.log(`[MEDIA] MAPS ${trigger} sudah dikirim, skip duplikasi.`);
      return;
    }
    sentMaps.set(key, Date.now());
  }

  try {
    if (type === 'MAPS') {
      const fp = path.join(MEDIA_DIR, MAPS_FILES[pk]);
      if (fs.existsSync(fp)) {
        await client.sendMessage(chatId, fs.readFileSync(fp, 'utf8').trim());
        console.log(`[MEDIA ✅] MAPS ${pk} → ${chatId}`);
      } else console.warn(`[MEDIA ⚠️] File tidak ada: ${fp}`);

    } else if (type === 'VIDEO') {
      const fp = path.join(MEDIA_DIR, VIDEO_FILES[pk]);
      if (fs.existsSync(fp)) {
        await client.sendMessage(chatId, MessageMedia.fromFilePath(fp), {
          caption: `Video suasana ${meta.name} ya Kak 🏡✨ Di ${meta.area}, rapi & asri!`
        });
        console.log(`[MEDIA ✅] VIDEO ${pk} → ${chatId}`);
      } else console.warn(`[MEDIA ⚠️] File tidak ada: ${fp}`);

    } else if (type === 'PL') {
      const fp = path.join(MEDIA_DIR, PL_FILES[pk]);
      if (fs.existsSync(fp)) {
        await client.sendMessage(chatId, MessageMedia.fromFilePath(fp), {
          caption: `Brosur & pricelist resmi ${meta.name} ya Kak 📋✨ Harga ${meta.harga}`
        });
        console.log(`[MEDIA ✅] PL ${pk} → ${chatId}`);
      } else console.warn(`[MEDIA ⚠️] File tidak ada: ${fp}`);
    }
  } catch (err) {
    console.error(`[MEDIA ❌] ${trigger}:`, err.message);
  }
}

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe'
];
let chromePath = null;
for (const p of CHROME_PATHS) if (fs.existsSync(p)) { chromePath = p; break; }

const wa = new Client({
  authStrategy: new LocalAuth({ clientId: 'pesona-kahuripan-bot' }),
  authTimeoutMs: 120_000,
  puppeteer: {
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas', '--no-first-run', '--disable-gpu',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'
    ]
  }
});

wa.on('qr', qr => {
  currentQr        = qr;
  currentBotStatus = 'qr';
  console.log('[WA] QR Code ready.');
  io.emit('qr', qr);
});

wa.on('authenticated', () => {
  currentBotStatus = 'authenticated';
  console.log('[WA] Authenticated.');
  io.emit('status', { state: 'authenticated' });
});

wa.on('ready', async () => {
  try {
    currentBotStatus = 'ready';
    currentQr        = null;
    let name  = 'Ariel Pesona Kahuripan';
    let phone = '';
    try {
      const info = wa.info;
      name  = info?.pushname || name;
      phone = info?.wid?.user || '';
    } catch (_) {}
    botAccountInfo = { user: name, phone };
    console.log(`[WA] Ready: ${name} (${phone})`);
    io.emit('ready', { user: name, phone, timestamp: new Date().toISOString() });
  } catch (errReady) {
    console.warn('[WA] Ready handler notice:', errReady.message);
  }
});

wa.on('auth_failure', msg => {
  console.error('[WA] Auth failure:', msg);
  currentBotStatus = 'initializing';
  io.emit('status', { state: 'initializing', text: 'Auth gagal, silakan scan QR baru...' });
});

wa.on('disconnected', reason => {
  console.warn('[WA] Disconnected:', reason);
  currentBotStatus = 'initializing';
  botAccountInfo   = null;
  currentQr        = null;
  io.emit('status', { state: 'initializing', text: 'Terputus dari WhatsApp.' });
});

// ─── Message handler ──────────────────────────────────────────────────────────
// userState: sender → { pendingMsgs, lastMsg, timer, isProcessing }
const userStates = new Map();
const DEBOUNCE_MS = config.debounceMs;

async function processMessages(sender) {
  const st = userStates.get(sender);
  if (!st || st.pendingMsgs.length === 0) {
    userStates.delete(sender);
    return;
  }
  if (conversationStore.isBotPaused(sender)) {
    for (const message of st.pendingMsgs) pushHistory(sender, 'user', message);
    clearTimeout(st.timer);
    userStates.delete(sender);
    console.log(`[FILTER] Bot untuk ${sender} sedang diambil alih sales.`);
    return;
  }

  // Ambil semua pesan yang antri, kosongkan pending
  st.isProcessing = true;
  const msgs    = [...st.pendingMsgs];
  const lastMsg = st.lastMsg;
  st.pendingMsgs = [];
  st.lastMsg     = null;

  // Format: jika >1 pesan, satukan menjadi 1 teks konteks utuh untuk AI
  let combined;
  if (msgs.length === 1) {
    combined = msgs[0];
  } else {
    combined = msgs.join('\n');
  }

  console.log(`[QUEUE] ${sender}: ${msgs.length} pesan beruntun digabung → 1 API call.`);

  // Simulasi typing natural
  await sleep(Math.floor(Math.random() * 800) + 1200);

  try {
    const { reply_text, trigger_actions } = await queryAI(combined, sender);

    const outData = {
      to: sender,
      body: reply_text,
      trigger: trigger_actions[0] || 'NONE',
      triggers: trigger_actions,
      timestamp: new Date().toISOString()
    };

    if (lastMsg && typeof lastMsg.reply === 'function') {
      try {
        await lastMsg.reply(reply_text);
      } catch (errReply) {
        console.warn(`[REPLY WARN] lastMsg.reply failed: ${errReply.message}, sending via sendMessage`);
        await wa.sendMessage(sender, reply_text);
      }
    } else {
      await wa.sendMessage(sender, reply_text);
    }

    // Statistik dan dashboard hanya mencatat pesan yang benar-benar berhasil dikirim.
    countOut++;
    recentLogs.push({ type: 'out', data: outData });
    if (recentLogs.length > 60) recentLogs.shift();
    const stored = conversationStore.addOutgoing(sender, reply_text, outData);
    console.log(`[MSG OUT] ${sender}: "${reply_text}" [${trigger_actions.join(',') || 'NONE'}]`);
    io.emit('message_out', outData);
    io.emit('conversation_message', { contactId: sender, ...stored });
    io.emit('stats_update', { countIn, countOut });

    // Kirim media yang di-trigger jika ada
    for (const trigger of trigger_actions) {
      await sleep(1500);
      await sendMedia(wa, sender, trigger, combined);
    }
  } catch (e) {
    console.error('[MSG OUT ERROR]:', e.message);
  }

  st.isProcessing = false;

  // Setelah selesai, jika ada pesan baru yang masuk saat processing → beri waktu debounce lagi agar tidak spam
  if (st.pendingMsgs.length > 0) {
    console.log(`[QUEUE] ${sender}: ${st.pendingMsgs.length} pesan baru masuk saat processing, debounce ${DEBOUNCE_MS}ms.`);
    clearTimeout(st.timer);
    st.timer = setTimeout(() => processMessages(sender), DEBOUNCE_MS);
  } else {
    userStates.delete(sender);
  }
}

wa.on('message', async msg => {
  try {
    // Skip grup, broadcast, pesan dikirim bot sendiri
    if (msg.from === 'status@broadcast' || msg.from.includes('@g.us') || msg.fromMe) return;

    const sender = msg.from;
    const body   = msg.body?.trim();
    if (!body) return;

    // Cek kontak tersimpan
    let isSaved = false, contactName = null;
    try {
      const c = await msg.getContact();
      isSaved     = Boolean(c?.isMyContact === true || (c?.name && typeof c.name === 'string' && c.name.trim().length > 0));
      contactName = c?.name || c?.pushname || null;
    } catch (err) {
      console.warn(`[CONTACT ⚠️] Gagal ambil kontak ${sender}:`, err.message);
    }

    countIn++;
    const inData = {
      sender,
      body,
      isSaved,
      isSavedContact: isSaved,
      contactName,
      timestamp: new Date().toISOString()
    };
    recentLogs.push({ type: 'in', data: inData });
    if (recentLogs.length > 60) recentLogs.shift();
    const stored = conversationStore.addIncoming(sender, body, inData);

    // Emit ke dashboard
    io.emit('message_in', inData);
    io.emit('conversation_message', { contactId: sender, ...stored });
    io.emit('stats_update', { countIn, countOut });

    // Filter kontak tersimpan (hanya balas nomor yang tidak tersimpan)
    if (filterSavedContact && isSaved) {
      pushHistory(sender, 'user', body);
      console.log(`[FILTER 🛡️] Kontak tersimpan "${contactName || sender}" (${sender}) dilewati (tidak dibalas).`);
      return;
    }
    if (!isBotActive)        { pushHistory(sender, 'user', body); console.log(`[FILTER] Bot off, skip.`); return; }
    if (conversationStore.isBotPaused(sender)) {
      pushHistory(sender, 'user', body);
      console.log(`[FILTER] ${sender} sedang ditangani sales, bot per nomor dilewati.`);
      return;
    }
    if (!isOperatingHours()) { pushHistory(sender, 'user', body); console.log(`[FILTER] Di luar jam kerja, skip.`); return; }

    console.log(`[MSG IN] ${sender}: "${body}"`);

    // Inisiasi state jika belum ada
    if (!userStates.has(sender)) {
      userStates.set(sender, { pendingMsgs: [], lastMsg: null, timer: null, isProcessing: false });
    }
    const st = userStates.get(sender);
    st.pendingMsgs.push(body);
    st.lastMsg = msg;

    // Jika bot sedang processing pesan sebelumnya → simpan di antrian
    if (st.isProcessing) {
      console.log(`[QUEUE] ${sender}: sedang processing, pesan "${body}" dimasukkan antrian.`);
      return;
    }

    // Reset debounce timer — tunggu DEBOUNCE_MS sejak pesan TERAKHIR masuk sebelum memanggil AI
    clearTimeout(st.timer);
    st.timer = setTimeout(() => processMessages(sender), DEBOUNCE_MS);

  } catch (e) {
    console.error('[MSG PIPELINE ERROR]:', e.message);
  }
});

// ─── Socket.io / Dashboard ────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[SOCKET] +${socket.id}`);

  if (currentBotStatus === 'ready' && botAccountInfo) {
    socket.emit('ready', { ...botAccountInfo, timestamp: new Date().toISOString() });
  } else if (currentQr) {
    socket.emit('qr', currentQr);
  } else {
    socket.emit('status', { state: currentBotStatus, text: 'Memuat...' });
  }

  socket.emit('operational_status', getOpStatus());
  socket.emit('recent_logs', recentLogs);
  socket.emit('conversation_list', conversationStore.list());

  socket.on('get_conversation', data => {
    const contactId = typeof data === 'string' ? data : data?.contactId;
    if (!contactId) return;
    const summary = conversationStore.markRead(contactId);
    const conversation = conversationStore.get(contactId);
    if (!conversation) return;
    socket.emit('conversation_data', conversation);
    if (summary) io.emit('conversation_updated', summary);
  });

  socket.on('set_contact_bot', data => {
    const contactId = data?.contactId;
    if (!contactId) return;
    const summary = conversationStore.setBotPaused(contactId, data.paused);
    if (summary.botPaused) {
      const state = userStates.get(contactId);
      if (state) {
        clearTimeout(state.timer);
        for (const message of state.pendingMsgs) pushHistory(contactId, 'user', message);
      }
      userStates.delete(contactId);
    }
    io.emit('conversation_updated', summary);
  });

  socket.on('set_lead_status', data => {
    const summary = conversationStore.setLeadStatus(data?.contactId, data?.status);
    if (summary) io.emit('conversation_updated', summary);
  });

  socket.on('send_manual_message', async (data, acknowledge = () => {}) => {
    const contactId = data?.contactId;
    const body = typeof data?.body === 'string' ? data.body.trim() : '';
    if (!contactId || !body || body.length > 4000) {
      acknowledge({ ok: false, error: 'Pesan tidak valid.' });
      return;
    }
    if (currentBotStatus !== 'ready') {
      acknowledge({ ok: false, error: 'WhatsApp belum terhubung.' });
      return;
    }

    try {
      await wa.sendMessage(contactId, body);
      const timestamp = new Date().toISOString();
      const stored = conversationStore.addOutgoing(contactId, body, { timestamp, sentBy: 'sales' });
      pushHistory(contactId, 'assistant', body, []);
      countOut++;
      io.emit('conversation_message', { contactId, ...stored });
      io.emit('stats_update', { countIn, countOut });
      acknowledge({ ok: true });
    } catch (error) {
      console.error(`[MANUAL MESSAGE] ${contactId}: ${error.message}`);
      acknowledge({ ok: false, error: 'Pesan gagal dikirim.' });
    }
  });

  socket.on('toggle_bot', data => {
    isBotActive = Boolean(data?.enabled);
    console.log(`[TOGGLE] Bot: ${isBotActive ? 'ON' : 'OFF'}`);
    io.emit('operational_status', getOpStatus());
  });

  socket.on('toggle_contact_filter', data => {
    filterSavedContact = Boolean(data?.onlyNew);
    console.log(`[TOGGLE] Filter kontak: ${filterSavedContact ? 'Hanya nomor baru' : 'Semua nomor'}`);
    io.emit('operational_status', getOpStatus());
  });

  socket.on('clear_chat_logs', () => {
    recentLogs.length = 0;
    io.emit('chat_logs_cleared');
  });

  socket.on('disconnect', () => console.log(`[SOCKET] -${socket.id}`));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
server.listen(PORT, config.host, () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log(`🚀 Pesona Kahuripan WhatsApp Bot — Port ${PORT}`);
  console.log(`🤖 Gemini: ${GEMINI_MODELS.join(', ')} (${keys.keys.length} Keys)`);
  if (deepseekKeys.hasKeys()) {
    console.log(`🧠 DeepSeek: ${DEEPSEEK_MODEL} (${deepseekKeys.keys.length} Keys via xKiro API)`);
  }
  console.log(`📱 Dashboard: http://${config.host}:${PORT}`);
  console.log(`🕒 Jam kerja: ${config.operatingStartHour}.00–${config.operatingEndHour}.00 (${config.operatingTimeZone})`);
  console.log('═══════════════════════════════════════════════════════');
});

wa.initialize().catch(err => {
  console.error('[WA] Gagal menginisialisasi client:', err.message);
  currentBotStatus = 'disconnected';
  io.emit('status', { state: 'disconnected', text: 'Gagal menginisialisasi WhatsApp.' });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SYSTEM] ${signal} diterima, menutup aplikasi...`);

  for (const state of userStates.values()) clearTimeout(state.timer);
  conversationStore.flush();
  await Promise.allSettled([
    new Promise(resolve => io.close(resolve)),
    new Promise(resolve => server.close(resolve)),
    wa.destroy()
  ]);
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
