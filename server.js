// Backend kecil Pink Charity Auction
// - Midtrans Snap  : buat transaksi isi saldo + cek status
// - RajaOngkir     : cari kota/kecamatan + hitung ongkir
// Server Key & API Key HANYA ada di sini (file .env), tidak di aplikasi Flutter.

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;
// .trim() + buang tanda kutip: file .env dari Windows sering menyisakan spasi / \r
const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
const SERVER_KEY = clean(process.env.MIDTRANS_SERVER_KEY);
const IS_PROD = clean(process.env.MIDTRANS_IS_PRODUCTION).toLowerCase() === 'true';
const RO_KEY = clean(process.env.RAJAONGKIR_API_KEY);

// fetch bawaan Node baru ada di Node 18+
if (typeof fetch !== 'function') {
  console.error('Node.js kamu terlalu lama (' + process.version + '). Pakai Node 18 ke atas.');
  process.exit(1);
}

// Catatan: key Midtrans format baru ("Mid-server-...") dipakai di Sandbox MAUPUN Production,
// jadi mode ditentukan HANYA oleh MIDTRANS_IS_PRODUCTION (false = Sandbox).
function midtransKeyProblem() {
  if (!SERVER_KEY) return 'MIDTRANS_SERVER_KEY belum diisi di backend/.env';
  return null;
}

const SNAP_URL = IS_PROD
  ? 'https://app.midtrans.com/snap/v1/transactions'
  : 'https://app.sandbox.midtrans.com/snap/v1/transactions';
const CORE_URL = IS_PROD
  ? 'https://api.midtrans.com/v2'
  : 'https://api.sandbox.midtrans.com/v2';
const RO_URL = 'https://rajaongkir.komerce.id/api/v1';

const midtransAuth = () =>
  'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64');

const publicUrl = (req) =>
  (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// Dianggap "lunas" menurut dokumentasi Midtrans
function isPaid(status, fraud) {
  return (
    status === 'settlement' || (status === 'capture' && (fraud || 'accept') === 'accept')
  );
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    midtrans_key_set: !!SERVER_KEY,
    midtrans_mode: IS_PROD ? 'production' : 'sandbox',
    midtrans_problem: midtransKeyProblem(),
    rajaongkir_key_set: !!RO_KEY,
  });
});

// ---------------------------------------------------------------------------
// MIDTRANS
// ---------------------------------------------------------------------------

// Buat transaksi isi saldo -> kembalikan redirect_url untuk dibuka di WebView
app.post('/midtrans/create', async (req, res) => {
  try {
    const problem = midtransKeyProblem();
    if (problem) return res.status(500).json({ error: problem });

    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 10000 || amount > 20000000) {
      return res.status(400).json({ error: 'Nominal isi saldo harus Rp 10.000 - Rp 20.000.000' });
    }

    const orderId = `TOPUP-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const body = {
      transaction_details: { order_id: orderId, gross_amount: amount },
      item_details: [
        { id: 'saldo', price: amount, quantity: 1, name: 'Isi Saldo Pink Charity' },
      ],
      customer_details: {
        first_name: String(req.body.name || 'Pengguna').slice(0, 50),
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(req.body.email || ''))
          ? String(req.body.email)
          : 'user@example.com',
      },
      callbacks: { finish: `${publicUrl(req)}/payment/finish` },
    };

    const r = await fetch(SNAP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: midtransAuth(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.redirect_url) {
      const detail = Array.isArray(data.error_messages)
        ? data.error_messages.join('; ')
        : data.status_message || JSON.stringify(data);
      console.error('[Midtrans] ditolak', r.status, detail);
      const hint = r.status === 401
        ? ' (Server Key salah, atau key Production dipakai di mode Sandbox. Pastikan key diambil dari dashboard.sandbox.midtrans.com)'
        : '';
      return res.status(502).json({ error: `Midtrans menolak permintaan [${r.status}]: ${detail}${hint}` });
    }
    res.json({ order_id: orderId, token: data.token, redirect_url: data.redirect_url });
  } catch (e) {
    const why = e.cause?.code || e.name;
    console.error('[Midtrans] gagal menghubungi Midtrans:', e);
    res.status(500).json({
      error: `Backend tidak bisa menjangkau Midtrans (${why}). Cek koneksi internet laptop / firewall / antivirus.`,
    });
  }
});

// Cek status pembayaran (dipakai aplikasi untuk memastikan saldo boleh ditambah)
app.get('/midtrans/status/:orderId', async (req, res) => {
  try {
    const r = await fetch(`${CORE_URL}/${encodeURIComponent(req.params.orderId)}/status`, {
      headers: { Accept: 'application/json', Authorization: midtransAuth() },
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    // 404 = pelanggan belum memilih metode bayar -> anggap pending
    if (String(d.status_code) === '404') {
      return res.json({ order_id: req.params.orderId, status: 'pending', paid: false, amount: 0 });
    }
    res.json({
      order_id: d.order_id,
      status: d.transaction_status,
      paid: isPaid(d.transaction_status, d.fraud_status),
      amount: Math.round(parseFloat(d.gross_amount || '0')),
      payment_type: d.payment_type,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Webhook (opsional): isi URL ini di Midtrans Dashboard > Settings > Payment >
// Notification URL  ->  https://alamat-backend-kamu/midtrans/notification
app.post('/midtrans/notification', (req, res) => {
  const n = req.body || {};
  const expected = crypto
    .createHash('sha512')
    .update(`${n.order_id}${n.status_code}${n.gross_amount}${SERVER_KEY}`)
    .digest('hex');
  if (n.signature_key !== expected) return res.status(403).json({ error: 'signature tidak valid' });
  console.log('[Midtrans]', n.order_id, n.transaction_status, isPaid(n.transaction_status, n.fraud_status));
  res.json({ ok: true });
});

// Halaman yang tampil setelah pembayaran selesai (dideteksi oleh WebView di aplikasi)
app.get('/payment/finish', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Selesai</title>
<style>body{font-family:sans-serif;background:#fff0f5;text-align:center;padding-top:20vh;color:#c2185b}</style>
</head><body><h2>Pembayaran diproses ðŸ’•</h2><p>Kembali ke aplikasi Pink Charityâ€¦</p></body></html>`);
});

// ---------------------------------------------------------------------------
// RAJAONGKIR (Komerce)
// ---------------------------------------------------------------------------

async function rajaOngkir(path, options = {}) {
  if (!RO_KEY) throw new Error('RAJAONGKIR_API_KEY belum diisi di .env');
  const r = await fetch(`${RO_URL}/${path}`, {
    ...options,
    headers: { key: RO_KEY, Accept: 'application/json', ...(options.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

// Cari kota / kecamatan: GET /shipping/destination?search=surabaya
app.get('/shipping/destination', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    if (search.length < 3) return res.json({ data: [] });
    const qs = new URLSearchParams({ search, limit: '15', offset: '0' });
    const { status, data } = await rajaOngkir(`destination/domestic-destination?${qs}`);
    res.status(status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hitung ongkir: POST /shipping/cost {origin, destination, weight, courier}
app.post('/shipping/cost', async (req, res) => {
  try {
    const { origin, destination, weight, courier } = req.body || {};
    if (!origin || !destination || !weight || !courier) {
      return res.status(400).json({ error: 'origin, destination, weight, courier wajib diisi' });
    }
    const form = new URLSearchParams({
      origin: String(origin),
      destination: String(destination),
      weight: String(weight),
      courier: String(courier),
    });
    const { status, data } = await rajaOngkir('calculate/domestic-cost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    res.status(status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// AI TEXT (Groq Free Tier - Auto-Detect Model Aktif)
// ---------------------------------------------------------------------------
const GROQ_KEY = clean(process.env.GROQ_API_KEY);
let cachedGroqModel = null;

async function getGroqModel() {
  if (cachedGroqModel) return cachedGroqModel;
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
  });
  const d = await r.json().catch(() => ({}));
  const list = (d.data || [])
    .map((m) => m.id)
    .filter((id) => id && !/whisper|guard|tts|audio/i.test(id));
  cachedGroqModel =
    list.find((id) => /llama-3\.1-8b-instant/i.test(id)) ||
    list.find((id) => /llama|qwen|gemma|mixtral/i.test(id)) ||
    list[0] ||
    'llama-3.1-8b-instant';
  console.log('[AI Groq] model aktif:', cachedGroqModel);
  return cachedGroqModel;
}

app.post('/api/gemini', async (req, res) => {
  try {
    if (!GROQ_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY belum diisi di .env' });
    }
    const { prompt, temperature = 0.4 } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: 'prompt wajib diisi' });
    }

    const model = await getGroqModel();
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: String(prompt) }],
        temperature: Number(temperature),
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      cachedGroqModel = null;
      const msg = data?.error?.message || JSON.stringify(data);
      console.error('[AI Groq] gagal:', r.status, msg);
      return res.status(502).json({ error: msg });
    }

    const text = data?.choices?.[0]?.message?.content || '';
    res.json({ text: text.trim() });
  } catch (e) {
    console.error('[AI Groq] error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend Pink Charity jalan di port ${PORT}`);
  console.log(`Midtrans mode : ${IS_PROD ? 'PRODUCTION' : 'sandbox'}`);
  const problem = midtransKeyProblem();
  console.log(problem ? `!! MASALAH MIDTRANS: ${problem}` : 'Midtrans key  : OK');
  if (!RO_KEY) console.log('!! RAJAONGKIR_API_KEY belum diisi di .env');
});




