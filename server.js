require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const multer   = require('multer');
const FormData = require('form-data');
const admin    = require('firebase-admin');
const cors     = require('cors');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ═══════════════════════════════════════
   FIREBASE ADMIN INIT
═══════════════════════════════════════ */
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
    db = admin.firestore();
    console.log('✅ Firebase connected');
  } else {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — DB features disabled');
  }
} catch (e) {
  console.error('Firebase init error:', e.message);
}

/* ═══════════════════════════════════════
   HELPERS
═══════════════════════════════════════ */
const PLT_MAP = {
  // English / domains
  'amazon.sa': 'amazon', 'amazon.com': 'amazon', 'amazon.ae': 'amazon', 'amazon': 'amazon',
  'noon.com': 'noon', 'noon.sa': 'noon', 'noon': 'noon',
  'aliexpress.com': 'aliexpress', 'ar.aliexpress': 'aliexpress', 'aliexpress': 'aliexpress',
  'shein.com': 'shein', 'ar.shein': 'shein', 'us.shein': 'shein', 'shein': 'shein',
  'temu.com': 'temu', 'temu': 'temu',
  // Arabic source names (as returned by SerpAPI)
  'أمازون': 'amazon',
  'نون': 'noon',
  'علي اكسبريس': 'aliexpress', 'علي إكسبريس': 'aliexpress', 'علي‌اكسبريس': 'aliexpress',
  'شي ان': 'shein', 'شيان': 'shein', 'شي إن': 'shein',
  'تيمو': 'temu',
};

const DELIVERY = {
  amazon: '2-4 أيام', noon: '3-5 أيام',
  aliexpress: '15-30 يوم', shein: '12-20 يوم', temu: '14-25 يوم',
};

function detectPlatform(source = '', link = '') {
  const hay = (source + ' ' + link).toLowerCase();
  for (const [k, v] of Object.entries(PLT_MAP))
    if (hay.includes(k)) return v;
  return null;
}

function parsePrice(raw) {
  if (!raw) return null;
  // Convert Arabic-Indic (٠-٩) and Extended Arabic (۰-۹) numerals to ASCII
  const normalized = String(raw)
    .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0)
    .replace(/،/g, '')   // Arabic thousands separator
    .replace(/٬/g, '');  // Arabic comma
  const n = parseFloat(normalized.replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

const PLT_SEARCH_URL = {
  amazon:     q => `https://www.amazon.sa/s?k=${encodeURIComponent(q)}&ref=qaren`,
  noon:       q => `https://www.noon.com/saudi-en/search/?q=${encodeURIComponent(q)}`,
  aliexpress: q => `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(q)}`,
  shein:      q => `https://www.shein.com/search.html?q=${encodeURIComponent(q)}`,
  temu:       q => `https://www.temu.com/search_result.html?search_key=${encodeURIComponent(q)}`,
};

function resolveLink(item, plt) {
  const raw = item.product_link || item.link || '';
  // Use direct link only if it points to the actual platform (not google)
  if (raw && !raw.includes('google.com') && !raw.includes('gstatic')) return raw;
  // Fall back to platform search with product name
  return PLT_SEARCH_URL[plt] ? PLT_SEARCH_URL[plt](item.title || '') : raw;
}

function toProduct(item, plt) {
  const price = parsePrice(item.price ?? item.extracted_price);
  if (!price) return null;
  return {
    platform: plt,
    name: item.title,
    price,
    priceRaw: item.price ?? `${price} ر.س`,
    image: item.thumbnail ? `/api/img?url=${encodeURIComponent(item.thumbnail)}` : null,
    link: resolveLink(item, plt),
    source: item.source || '',
    rating: item.rating ?? null,
    reviews: item.reviews ?? item.reviews_count ?? null,
    delivery: DELIVERY[plt],
  };
}

function groupByPlatform(items = [], perPlatform = 1) {
  const buckets = {};
  for (const item of items) {
    const plt = detectPlatform(item.source, item.link);
    if (!plt) continue;
    const p = toProduct(item, plt);
    if (!p) continue;
    if (!buckets[plt]) buckets[plt] = [];
    if (buckets[plt].length < perPlatform) buckets[plt].push(p);
  }
  // Return flat list sorted cheapest-first within each platform
  return Object.values(buckets).flat().sort((a, b) => a.price - b.price);
}

/* ═══════════════════════════════════════
   DEBUG — raw SerpAPI results (remove in prod)
═══════════════════════════════════════ */
app.get('/api/debug-search', async (req, res) => {
  const q = (req.query.q || 'iphone').trim();
  if (!process.env.SERP_API_KEY) return res.status(503).json({ error: 'no key' });
  try {
    const { data } = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google_shopping', q, gl: 'sa', hl: 'ar', num: 10, api_key: process.env.SERP_API_KEY },
      timeout: 20000,
    });
    const sample = (data.shopping_results || []).slice(0, 10).map(i => ({
      source: i.source, link: i.link, price: i.price, title: i.title?.slice(0, 40),
    }));
    res.json({ total: (data.shopping_results || []).length, sample });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════
   IMAGE PROXY  (bypass CORS for thumbnails)
═══════════════════════════════════════ */
app.get('/api/img', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).end();
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.google.com' },
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch { res.status(404).end(); }
});

/* ═══════════════════════════════════════
   SERVE FIREBASE CONFIG (safe, public)
═══════════════════════════════════════ */
app.get('/api/config', (_req, res) => {
  res.json({
    apiKey:            process.env.FIREBASE_API_KEY       || '',
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN   || '',
    projectId:         process.env.FIREBASE_PROJECT_ID    || '',
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_ID  || '',
    appId:             process.env.FIREBASE_APP_ID        || '',
  });
});

/* ═══════════════════════════════════════
   GOOGLE CSE SEARCH  (مجاني 100/يوم)
   طلبان فقط: SA + Global يغطيان كل المنصات
═══════════════════════════════════════ */
function extractPriceFromText(text = '') {
  const normalized = text
    .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
  const m = normalized.match(/(?:sar|ر\.س|\$|usd)?\s*(\d[\d,\.]+)\s*(?:sar|ر\.س|\$)?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return isNaN(n) || n < 0.5 || n > 500000 ? null : n;
}

function cseItemToProduct(item) {
  const link = item.link || '';
  const plt  = detectPlatform('', link);
  if (!plt) return null;

  const pm       = item.pagemap || {};
  const offer    = (pm.offer || pm.product || pm.aggregateoffer || [{}])[0] || {};
  const img      = (pm.cse_image || pm.cse_thumbnail || [{}])[0]?.src || null;
  const priceRaw = offer.price || offer.lowprice || offer.highprice || '';
  const price    = parsePrice(priceRaw) || extractPriceFromText(item.snippet || '') || extractPriceFromText(item.title || '');

  // Include even without price — link is still valuable
  return {
    platform: plt,
    name:     item.title.replace(/ - .*$/, '').replace(/ \| .*$/, '').replace(/ — .*$/, ''),
    price:    price || 0,
    priceRaw: price ? `${price} ر.س` : 'تحقق من السعر',
    noPrice:  !price,
    image:    img ? `/api/img?url=${encodeURIComponent(img)}` : null,
    link,
    source:   plt,
    rating:   offer.ratingvalue ? parseFloat(offer.ratingvalue) : null,
    reviews:  offer.reviewcount ? parseInt(offer.reviewcount) : null,
    delivery: DELIVERY[plt],
  };
}

async function runCseQuery(q, gKey, gCx, extraParams = {}) {
  const { data } = await axios.get('https://www.googleapis.com/customsearch/v1', {
    params: { key: gKey, cx: gCx, q, num: 10, ...extraParams },
    timeout: 12000,
  });
  return (data.items || []).map(cseItemToProduct).filter(Boolean);
}

/* ═══════════════════════════════════════
   TEXT SEARCH  →  SerpAPI OR Google CSE
═══════════════════════════════════════ */
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query required' });

  /* ── Google CSE (free — 2 requests per search) ── */
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) {
    try {
      const gKey = process.env.GOOGLE_API_KEY;
      const gCx  = process.env.GOOGLE_CSE_ID;
      const [saItems, usItems] = await Promise.all([
        runCseQuery(q, gKey, gCx, { gl: 'sa', hl: 'ar', cr: 'countrySA' }).catch(() => []),
        runCseQuery(q, gKey, gCx, { gl: 'us', hl: 'en' }).catch(() => []),
      ]);
      const buckets = {};
      for (const p of [...saItems, ...usItems]) {
        if (!buckets[p.platform]) buckets[p.platform] = [];
        const slot = buckets[p.platform];
        if (slot.length < 3 && (!p.noPrice || !slot.some(x => !x.noPrice))) slot.push(p);
      }
      const results = Object.values(buckets).flat()
        .sort((a, b) => (a.noPrice ? 1 : 0) - (b.noPrice ? 1 : 0) || a.price - b.price);
      console.log('CSE platforms found:', [...new Set(results.map(r => r.platform))]);

      if (results.length > 0)
        return res.json({ results, query: q, fallback: false, engine: 'cse' });

      console.log('CSE 0 results — trying SerpAPI');
    } catch (err) {
      console.error('CSE search error:', err.message);
    }
  }

  /* ── SerpAPI fallback ── */
  if (!process.env.SERP_API_KEY)
    return res.status(503).json({ error: 'No search engine configured', fallback: true });

  try {
    const key  = process.env.SERP_API_KEY;
    const base = { engine: 'google_shopping', q, num: 60, api_key: key };
    const [saRes, usRes] = await Promise.allSettled([
      axios.get('https://serpapi.com/search.json', { params: { ...base, gl: 'sa', hl: 'ar' }, timeout: 20000 }),
      axios.get('https://serpapi.com/search.json', { params: { ...base, gl: 'us', hl: 'en' }, timeout: 20000 }),
    ]);
    const saItems = saRes.status === 'fulfilled' ? (saRes.value.data.shopping_results || []) : [];
    const usItems = usRes.status === 'fulfilled' ? (usRes.value.data.shopping_results || []) : [];
    const results = groupByPlatform([...saItems, ...usItems], 3);
    console.log('SerpAPI platforms:', [...new Set(results.map(r => r.platform))]);
    res.json({ results, query: q, fallback: results.length === 0, engine: 'serp' });
  } catch (err) {
    console.error('Text search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Search failed', fallback: true });
  }
});

/* ═══════════════════════════════════════
   IMAGE SEARCH  →  ImgBB → Google Lens → Google Shopping
═══════════════════════════════════════ */
app.post('/api/search-image', upload.single('image'), async (req, res) => {
  if (!req.file)           return res.status(400).json({ error: 'Image required' });
  if (!process.env.SERP_API_KEY)
    return res.status(503).json({ error: 'SERP_API_KEY not configured', fallback: true });
  if (!process.env.IMGBB_API_KEY)
    return res.status(503).json({ error: 'IMGBB_API_KEY not configured', fallback: true });

  try {
    // 1. Upload image to ImgBB to get a public URL
    const form = new FormData();
    form.append('image', req.file.buffer.toString('base64'));
    form.append('key', process.env.IMGBB_API_KEY);

    const imgRes = await axios.post('https://api.imgbb.com/1/upload', form, {
      headers: form.getHeaders(), timeout: 15000,
    });
    const imageUrl = imgRes.data.data.url;

    // 2. Google Lens to identify product name
    const lensRes = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google_lens', url: imageUrl, api_key: process.env.SERP_API_KEY },
      timeout: 20000,
    });

    const lensData    = lensRes.data;
    const detectedName =
      lensData.knowledge_graph?.title ||
      lensData.visual_matches?.[0]?.title ||
      '';

    let results = [];

    if (detectedName) {
      // 3. Google Shopping with the detected product name
      const shopRes = await axios.get('https://serpapi.com/search.json', {
        params: {
          engine: 'google_shopping', q: detectedName,
          gl: 'sa', hl: 'ar', num: 60,
          api_key: process.env.SERP_API_KEY,
        },
        timeout: 20000,
      });
      results = groupByPlatform(shopRes.data.shopping_results || [], 3);
    } else {
      // Fallback: use visual matches directly
      results = groupByPlatform(lensData.visual_matches || [], 3);
    }

    res.json({ results, detectedName, imageUrl });
  } catch (err) {
    console.error('Image search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Image search failed', fallback: true });
  }
});

/* ═══════════════════════════════════════
   USERS  (email collection)
═══════════════════════════════════════ */
app.post('/api/users', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not configured' });
  const { uid, email, name } = req.body;
  if (!uid || !email) return res.status(400).json({ error: 'uid + email required' });
  try {
    await db.collection('users').doc(uid).set(
      { email, name: name || '', searchCount: 0, joinedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:uid/search', async (req, res) => {
  if (!db) return res.json({ ok: true });
  try {
    await db.collection('users').doc(req.params.uid).update({
      searchCount: admin.firestore.FieldValue.increment(1),
      lastSearch:  admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

/* ═══════════════════════════════════════
   FAVORITES
═══════════════════════════════════════ */
app.post('/api/favorites', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not configured' });
  const { uid, product } = req.body;
  if (!uid || !product) return res.status(400).json({ error: 'uid + product required' });
  try {
    const ref = await db.collection('favorites').add({
      uid, product, savedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, id: ref.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/favorites/:uid', async (req, res) => {
  if (!db) return res.json({ favorites: [] });
  try {
    const snap = await db.collection('favorites')
      .where('uid', '==', req.params.uid)
      .orderBy('savedAt', 'desc').limit(100).get();
    res.json({ favorites: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/favorites/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not configured' });
  try {
    await db.collection('favorites').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════
   ADMIN — export emails
   حماية بـ header سري
═══════════════════════════════════════ */
app.get('/api/admin/users', async (req, res) => {
  if (req.headers['x-admin'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });
  if (!db) return res.status(503).json({ error: 'DB not configured' });
  try {
    const snap = await db.collection('users').orderBy('joinedAt', 'desc').get();
    const users = snap.docs.map(d => {
      const { email, name, searchCount, joinedAt } = d.data();
      return { email, name, searchCount, joinedAt: joinedAt?.toDate()?.toISOString() };
    });
    res.json({ count: users.length, users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════
   START
═══════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 قارن — http://localhost:${PORT}`));
