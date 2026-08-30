require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const Database = require('better-sqlite3');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

/* ═══════════════════════════════════════
   VIDEO STORAGE
═══════════════════════════════════════ */
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'data', 'videos');
fs.mkdirSync(VIDEO_DIR, { recursive: true });
app.use('/videos', express.static(VIDEO_DIR, { maxAge: '30d' }));

const VALID_EXERCISES = new Set([
  'bench_press','db_bench','incline_press','pushup',
  'pullup','lat_pulldown','bb_row','db_row','cable_row','face_pull',
  'ohp','lateral_raise',
  'bicep_curl','hammer_curl','tricep_dip','tricep_ext',
  'squat','goblet_squat','sumo_squat','bulgarian','lunges',
  'rdl','deadlift','hip_thrust','glute_bridge','cable_kickback',
  'leg_press','leg_curl','leg_ext','calf_raise',
  'plank','russian_twist','leg_raise',
]);

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: VIDEO_DIR,
    filename: (req, file, cb) => {
      const id = req.params.id;
      if (!VALID_EXERCISES.has(id)) return cb(new Error('invalid exercise id'));
      const ext = path.extname(file.originalname).toLowerCase();
      const allowed = ['.mp4', '.webm', '.mov'];
      if (!allowed.includes(ext)) return cb(new Error('only mp4/webm/mov allowed'));
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB per video
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('not a video'));
  },
});

/* ═══════════════════════════════════════
   SQLite DATABASE
═══════════════════════════════════════ */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'urpass.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    gender TEXT NOT NULL DEFAULT 'female',
    created_at INTEGER NOT NULL,
    start_date INTEGER NOT NULL,
    end_date INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    profile_edits INTEGER NOT NULL DEFAULT 0,
    profile TEXT,
    macros TEXT,
    selected_plan TEXT,
    workout_progress TEXT DEFAULT '{}',
    phone TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_username ON subscribers(username);

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id TEXT NOT NULL,
    event TEXT NOT NULL,
    meta TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_sub ON activity_log(subscriber_id, created_at DESC);
`);

// Migrations: add columns if missing on existing DB
try {
  const cols = db.prepare("PRAGMA table_info(subscribers)").all();
  const names = cols.map(c => c.name);
  if (!names.includes('phone')) {
    db.exec("ALTER TABLE subscribers ADD COLUMN phone TEXT");
    console.log('✅ Migration: added phone column');
  }
  if (!names.includes('current_day')) {
    db.exec("ALTER TABLE subscribers ADD COLUMN current_day INTEGER DEFAULT 0");
    console.log('✅ Migration: added current_day column');
  }
  if (!names.includes('completed_days')) {
    db.exec("ALTER TABLE subscribers ADD COLUMN completed_days TEXT DEFAULT '[]'");
    console.log('✅ Migration: added completed_days column');
  }
  if (!names.includes('last_login')) {
    db.exec("ALTER TABLE subscribers ADD COLUMN last_login INTEGER");
    console.log('✅ Migration: added last_login column');
  }
  if (!names.includes('login_count')) {
    db.exec("ALTER TABLE subscribers ADD COLUMN login_count INTEGER DEFAULT 0");
    console.log('✅ Migration: added login_count column');
  }
} catch (e) { console.warn('migration skipped:', e.message); }

console.log('✅ SQLite ready at', DB_PATH);

const JWT_SECRET      = process.env.JWT_SECRET      || 'dev-secret-change-me';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'admin';
const MAX_PROFILE_EDITS = 3;

/* ═══════════════════════════════════════
   HELPERS
═══════════════════════════════════════ */
function signToken(payload, expiresIn = '30d') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'invalid token' }); }
}

function requireAdmin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ error: 'admin only' });
  next();
}

function requireSubscriber(req, res, next) {
  if (!req.user?.sub) return res.status(403).json({ error: 'subscriber only' });
  next();
}

function subscriptionStatus(sub) {
  const now = Date.now();
  const end = sub.end_date || 0;
  const active = sub.active === 1 && end > now;
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));
  return { active, daysLeft, startDate: sub.start_date, endDate: end, expired: end <= now };
}

function parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

// Normalize phone to international format without + (for wa.me links)
// Default country: Saudi Arabia (966)
function normalizePhone(raw, defaultCC = '966') {
  if (!raw) return '';
  let d = String(raw).replace(/\D/g, '');
  if (!d) return '';
  // Strip 00 prefix (international dial)
  if (d.startsWith('00')) d = d.slice(2);
  // Already has GCC/MENA country code
  const cc = ['966','971','965','973','974','968','962','20','961','963','964','967','212','216','218','249','252'];
  if (cc.some(c => d.startsWith(c) && d.length >= c.length + 7)) return d;
  // Local Saudi format (05xxxxxxxx) → 9665xxxxxxxx
  if (d.startsWith('0') && d.length >= 10) return defaultCC + d.slice(1);
  // Bare 5xxxxxxxx (9 digits) → 9665xxxxxxxx
  if (d.startsWith('5') && d.length === 9) return defaultCC + d;
  return d;
}

function firstNameOf(full) {
  return (full || '').trim().split(/\s+/)[0] || '';
}

/* ═══════════════════════════════════════
   ACTIVITY LOG
   Five high-signal events only — enough to tell engagement apart from
   inactivity without drowning the coach in meaningless page-view noise.
═══════════════════════════════════════ */
const VALID_EVENTS = new Set([
  'login',            // opened the portal
  'workout_complete', // finished a training day
  'set_logged',       // recorded sets for an exercise
  'calc_saved',       // saved calorie/macro profile
  'meal_print',       // printed the meal plan
]);

const MAX_LOG_PER_SUB = 400;

function logActivity(subscriberId, event, meta) {
  if (!subscriberId || !VALID_EVENTS.has(event)) return;
  try {
    stmts.insertActivity.run(
      subscriberId, event,
      meta ? JSON.stringify(meta) : null,
      Date.now()
    );
    // Trim occasionally so the log can't grow without bound.
    if (Math.random() < 0.05) stmts.trimActivity.run(subscriberId, subscriberId, MAX_LOG_PER_SUB);
  } catch (e) { /* logging must never break the request */ }
}

/* ═══════════════════════════════════════
   CLIENT METRICS  — turns raw data into decisions
═══════════════════════════════════════ */
const DAY = 86400000;

// Flattens workout_progress into a chronological list of sessions.
function sessionsOf(progress) {
  const out = [];
  for (const [exId, entries] of Object.entries(progress || {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const sets = Array.isArray(e.sets) ? e.sets
                 : (e.weight != null ? [{ w: e.weight, r: e.reps }] : []);
      const volume = sets.reduce((a, s) => a + (Number(s.w) || 0) * (Number(s.r) || 0), 0);
      const maxW   = sets.reduce((m, s) => Math.max(m, Number(s.w) || 0), 0);
      out.push({ exId, at: new Date(e.date).getTime() || 0, sets: sets.length, volume, maxW });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function daysSince(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / DAY);
}

/* Status drives the coach's action list — the whole point of tracking. */
function classify({ lastActivityAt, lastLogin, hasAnyActivity }) {
  if (!lastLogin && !hasAnyActivity) return { key: 'never_logged_in', label: 'لم يدخل',            tone: 'grey'   };
  if (!hasAnyActivity)               return { key: 'not_started',     label: 'لم يبدأ',            tone: 'slate'  };
  const d = daysSince(lastActivityAt);
  if (d <= 3)  return { key: 'committed', label: 'ملتزم',              tone: 'green'  };
  if (d <= 7)  return { key: 'wobbly',    label: 'متذبذب',             tone: 'amber'  };
  if (d <= 14) return { key: 'at_risk',   label: 'معرّض للانقطاع',      tone: 'orange' };
  return         { key: 'stalled',   label: 'متوقف',              tone: 'red'    };
}

/* Adherence = actual sessions ÷ sessions the chosen plan expects so far. */
function adherence(sub, completedDays) {
  const planDays = { '3': 3, '4': 4, '5': 5 }[String(sub.selected_plan || '').split('-')[1]] || 0;
  if (!planDays) return null;
  const start = sub.start_date || sub.created_at || Date.now();
  const weeks = Math.max(1, (Date.now() - start) / (7 * DAY));
  const expected = Math.round(weeks * planDays);
  if (expected <= 0) return null;
  return Math.min(100, Math.round((completedDays.length / expected) * 100));
}

/* Compares total volume of the last 7 days against the 7 before it. */
function volumeTrend(sessions) {
  const now = Date.now();
  let recent = 0, prior = 0;
  for (const s of sessions) {
    if (s.at >= now - 7 * DAY)       recent += s.volume;
    else if (s.at >= now - 14 * DAY) prior  += s.volume;
  }
  const pct = prior > 0 ? Math.round(((recent - prior) / prior) * 100)
            : (recent > 0 ? 100 : 0);
  return { recent, prior, pct };
}

/* Builds every derived metric for one subscriber. */
function clientMetrics(sub) {
  const progress      = parseJson(sub.workout_progress, {});
  const completedDays = parseJson(sub.completed_days, []);
  const sessions      = sessionsOf(progress);

  const lastSet      = sessions.length ? sessions[sessions.length - 1].at : null;
  const lastComplete = completedDays.length
    ? Math.max(...completedDays.map(c => new Date(c.date).getTime() || 0))
    : null;
  const lastActivityAt = Math.max(lastSet || 0, lastComplete || 0) || null;
  const hasAnyActivity = !!(sessions.length || completedDays.length);

  const now = Date.now();
  const sessions30 = sessions.filter(s => s.at >= now - 30 * DAY);
  const trend      = volumeTrend(sessions);

  // Personal bests, and how much each improved over the prior best.
  const bests = {};
  for (const s of sessions) {
    if (!s.maxW) continue;
    const b = bests[s.exId] || (bests[s.exId] = { best: 0, prevBest: 0 });
    if (s.maxW > b.best) { b.prevBest = b.best; b.best = s.maxW; }
  }
  // prevBest must be > 0 — a first-ever session is a baseline, not an improvement.
  const topGains = Object.entries(bests)
    .map(([exId, b]) => ({ exId, best: b.best, prevBest: b.prevBest, gain: b.best - b.prevBest }))
    .filter(g => g.prevBest > 0 && g.gain > 0)
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 3);

  return {
    status:            classify({ lastActivityAt, lastLogin: sub.last_login, hasAnyActivity }),
    lastActivityAt,
    daysSinceActivity: daysSince(lastActivityAt),
    lastLogin:         sub.last_login || null,
    daysSinceLogin:    daysSince(sub.last_login),
    loginCount:        sub.login_count || 0,
    completedCount:    completedDays.length,
    completed30:       completedDays.filter(c => (new Date(c.date).getTime() || 0) >= now - 30 * DAY).length,
    sessionsLogged:    sessions.length,
    sessions30:        sessions30.length,
    totalVolume:       Math.round(sessions.reduce((a, s) => a + s.volume, 0)),
    volume7:           Math.round(trend.recent),
    volumeTrendPct:    trend.pct,
    adherencePct:      adherence(sub, completedDays),
    exercisesTracked:  Object.keys(progress).length,
    topGains,
  };
}

/* ═══════════════════════════════════════
   WHATSAPP BUSINESS CLOUD API  (Meta)
   إرسال تلقائي لبيانات الدخول دون تدخل يدوي.
   يتطلب: WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID
   وقالب رسالة معتمد من Meta (WHATSAPP_TEMPLATE_NAME).
═══════════════════════════════════════ */
const WA_TOKEN     = process.env.WHATSAPP_API_TOKEN      || '';
const WA_PHONE_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WA_TEMPLATE  = process.env.WHATSAPP_TEMPLATE_NAME   || 'ur_pass_welcome';
const WA_LANG      = process.env.WHATSAPP_TEMPLATE_LANG   || 'ar';
const PUBLIC_URL   = (process.env.PUBLIC_URL || '').replace(/\/$/, '') || null;
const WA_ENABLED   = !!(WA_TOKEN && WA_PHONE_ID);

if (WA_ENABLED) console.log('✅ WhatsApp Business API configured — auto-send enabled');
else console.warn('⚠️  WhatsApp Business API not configured — falling back to manual wa.me links');

async function sendWhatsAppWelcome({ phone, fullName, username, password, loginUrl }) {
  if (!WA_ENABLED)  return { sent: false, reason: 'not_configured' };
  if (!phone)       return { sent: false, reason: 'no_phone' };

  const url = `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: WA_TEMPLATE,
      language: { code: WA_LANG },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: firstNameOf(fullName) || 'عزيزنا' },
          { type: 'text', text: loginUrl || (PUBLIC_URL ? PUBLIC_URL + '/' : '') },
          { type: 'text', text: username },
          { type: 'text', text: password },
        ],
      }],
    },
  };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = data?.error?.message || `HTTP ${r.status}`;
      console.error('WhatsApp send failed:', reason);
      return { sent: false, reason };
    }
    return { sent: true, id: data?.messages?.[0]?.id };
  } catch (e) {
    console.error('WhatsApp send error:', e.message);
    return { sent: false, reason: e.message };
  }
}

/* ═══════════════════════════════════════
   PREPARED STATEMENTS
═══════════════════════════════════════ */
const stmts = {
  findByUsername: db.prepare('SELECT * FROM subscribers WHERE username = ?'),
  findById:       db.prepare('SELECT * FROM subscribers WHERE id = ?'),
  listAll:        db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC'),
  insert:         db.prepare(`INSERT INTO subscribers
                    (id, username, password_hash, full_name, gender, phone, created_at, start_date, end_date, active, profile_edits)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`),
  updatePassword:    db.prepare('UPDATE subscribers SET password_hash = ? WHERE id = ?'),
  updateFullName:    db.prepare('UPDATE subscribers SET full_name = ? WHERE id = ?'),
  updatePhone:       db.prepare('UPDATE subscribers SET phone = ? WHERE id = ?'),
  updateActive:      db.prepare('UPDATE subscribers SET active = ? WHERE id = ?'),
  updateEndDate:     db.prepare('UPDATE subscribers SET end_date = ?, active = 1 WHERE id = ?'),
  resetEdits:        db.prepare('UPDATE subscribers SET profile_edits = 0 WHERE id = ?'),
  saveProfile:       db.prepare('UPDATE subscribers SET profile = ?, macros = ?, profile_edits = profile_edits + 1 WHERE id = ?'),
  savePlan:          db.prepare('UPDATE subscribers SET selected_plan = ?, current_day = 0, completed_days = ? WHERE id = ?'),
  saveProgress:      db.prepare('UPDATE subscribers SET workout_progress = ? WHERE id = ?'),
  saveCurrentDay:    db.prepare('UPDATE subscribers SET current_day = ?, completed_days = ? WHERE id = ?'),
  delete:            db.prepare('DELETE FROM subscribers WHERE id = ?'),

  touchLogin:        db.prepare('UPDATE subscribers SET last_login = ?, login_count = COALESCE(login_count,0) + 1 WHERE id = ?'),
  insertActivity:    db.prepare('INSERT INTO activity_log (subscriber_id, event, meta, created_at) VALUES (?, ?, ?, ?)'),
  activityFor:       db.prepare('SELECT event, meta, created_at FROM activity_log WHERE subscriber_id = ? ORDER BY created_at DESC LIMIT ?'),
  deleteActivityFor: db.prepare('DELETE FROM activity_log WHERE subscriber_id = ?'),
  // Keeps only the newest N rows for one subscriber.
  trimActivity:      db.prepare(`DELETE FROM activity_log
                                 WHERE subscriber_id = ? AND id NOT IN (
                                   SELECT id FROM activity_log WHERE subscriber_id = ?
                                   ORDER BY created_at DESC LIMIT ?
                                 )`),
};

/* ═══════════════════════════════════════
   PUBLIC — subscriber login
═══════════════════════════════════════ */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });

  try {
    const sub = stmts.findByUsername.get(username.trim().toLowerCase());
    if (!sub) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور خاطئة' });

    const ok = await bcrypt.compare(password, sub.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور خاطئة' });

    const status = subscriptionStatus(sub);
    if (!status.active) {
      return res.status(403).json({
        error: 'انتهت مدة اشتراكك',
        expired: true,
        message: 'يرجى التواصل مع خدمة العملاء لتجديد الاشتراك'
      });
    }

    stmts.touchLogin.run(Date.now(), sub.id);
    logActivity(sub.id, 'login');

    const token = signToken({ sub: sub.id, username: sub.username });
    res.json({
      token,
      user: {
        id: sub.id,
        username: sub.username,
        fullName: sub.full_name,
        gender: sub.gender,
        daysLeft: status.daysLeft,
        endDate: status.endDate,
        hasProfile: !!sub.profile,
        editsLeft: MAX_PROFILE_EDITS - (sub.profile_edits || 0),
        locked: (sub.profile_edits || 0) >= MAX_PROFILE_EDITS,
      }
    });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'حدث خطأ، حاولي مرة أخرى' });
  }
});

/* ═══════════════════════════════════════
   SUBSCRIBER — self endpoints
═══════════════════════════════════════ */
app.get('/api/me', auth, requireSubscriber, (req, res) => {
  const sub = stmts.findById.get(req.user.sub);
  if (!sub) return res.status(404).json({ error: 'not found' });
  const status = subscriptionStatus(sub);
  if (!status.active) return res.status(403).json({ error: 'انتهى اشتراكك', expired: true });
  res.json({
    id: sub.id,
    username: sub.username,
    fullName: sub.full_name,
    gender: sub.gender,
    profile: parseJson(sub.profile, null),
    macros:  parseJson(sub.macros, null),
    daysLeft: status.daysLeft,
    endDate: status.endDate,
    editsLeft: MAX_PROFILE_EDITS - (sub.profile_edits || 0),
    locked: (sub.profile_edits || 0) >= MAX_PROFILE_EDITS,
    workoutProgress: parseJson(sub.workout_progress, {}),
    selectedPlan: sub.selected_plan || null,
    currentDay: sub.current_day || 0,
    completedDays: parseJson(sub.completed_days, []),
  });
});

app.post('/api/me/profile', auth, requireSubscriber, (req, res) => {
  const { profile, macros } = req.body || {};
  if (!profile || !macros) return res.status(400).json({ error: 'incomplete data' });
  const sub = stmts.findById.get(req.user.sub);
  if (!sub) return res.status(404).json({ error: 'not found' });
  if ((sub.profile_edits || 0) >= MAX_PROFILE_EDITS) {
    return res.status(403).json({
      error: 'وصلتِ للحد الأقصى من التعديلات',
      locked: true,
      message: 'يرجى التواصل مع خدمة العملاء لإعادة تفعيل الحاسبة'
    });
  }
  stmts.saveProfile.run(JSON.stringify(profile), JSON.stringify(macros), sub.id);
  logActivity(sub.id, 'calc_saved', { goal: profile.goal, cal: macros.cal });
  res.json({ ok: true, editsLeft: MAX_PROFILE_EDITS - (sub.profile_edits + 1) });
});

app.post('/api/me/plan', auth, requireSubscriber, (req, res) => {
  const { selectedPlan } = req.body || {};
  stmts.savePlan.run(selectedPlan || null, '[]', req.user.sub);
  res.json({ ok: true });
});

// Fire-and-forget signal that the subscriber printed their meal plan.
app.post('/api/me/track', auth, requireSubscriber, (req, res) => {
  const { event } = req.body || {};
  if (event === 'meal_print') logActivity(req.user.sub, 'meal_print');
  res.json({ ok: true });
});

// Mark today's workout as complete → advance current_day (cycles through the plan)
app.post('/api/me/complete-day', auth, requireSubscriber, (req, res) => {
  const { totalDays } = req.body || {};
  const total = Math.max(1, parseInt(totalDays) || 3);
  const sub = stmts.findById.get(req.user.sub);
  if (!sub) return res.status(404).json({ error: 'not found' });
  const curr = sub.current_day || 0;
  const next = (curr + 1) % total;
  // Record completion timestamp for the day just finished
  const completed = parseJson(sub.completed_days, []);
  completed.push({ dayIdx: curr, date: new Date().toISOString() });
  // Keep only last 60 completions
  const trimmed = completed.slice(-60);
  stmts.saveCurrentDay.run(next, JSON.stringify(trimmed), sub.id);
  logActivity(sub.id, 'workout_complete', { dayIdx: curr, plan: sub.selected_plan });
  res.json({ ok: true, currentDay: next, previousDay: curr });
});

app.post('/api/me/progress', auth, requireSubscriber, (req, res) => {
  const { exerciseId, weight, reps, sets, date } = req.body || {};
  if (!exerciseId) return res.status(400).json({ error: 'exerciseId required' });
  const sub = stmts.findById.get(req.user.sub);
  if (!sub) return res.status(404).json({ error: 'not found' });
  const progress = parseJson(sub.workout_progress, {});
  if (!progress[exerciseId]) progress[exerciseId] = [];

  // New format: sets array. Legacy format: single weight/reps.
  let setArr;
  if (Array.isArray(sets)) {
    setArr = sets
      .map(s => ({ w: Number(s.w) || 0, r: Number(s.r) || 0 }))
      .filter(s => s.w > 0 || s.r > 0);
  } else {
    const w = Number(weight) || 0, r = Number(reps) || 0;
    if (w > 0 || r > 0) setArr = [{ w, r }];
  }
  if (!setArr || setArr.length === 0) return res.status(400).json({ error: 'no data' });

  progress[exerciseId].push({
    date: date || new Date().toISOString(),
    sets: setArr,
  });
  // keep only last 30 sessions per exercise
  if (progress[exerciseId].length > 30) progress[exerciseId] = progress[exerciseId].slice(-30);
  stmts.saveProgress.run(JSON.stringify(progress), sub.id);
  logActivity(sub.id, 'set_logged', {
    exerciseId,
    sets: setArr.length,
    volume: Math.round(setArr.reduce((a, s) => a + s.w * s.r, 0)),
  });
  res.json({ ok: true, saved: setArr.length });
});

/* ═══════════════════════════════════════
   ADMIN
═══════════════════════════════════════ */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'كلمة المرور خاطئة' });
  const token = signToken({ admin: true }, '7d');
  res.json({ token });
});

app.get('/api/admin/subscribers', auth, requireAdmin, (_req, res) => {
  const rows = stmts.listAll.all();
  const subscribers = rows.map(sub => {
    const st = subscriptionStatus(sub);
    const m  = clientMetrics(sub);
    return {
      id: sub.id,
      username: sub.username,
      fullName: sub.full_name,
      gender: sub.gender,
      phone: sub.phone || '',
      startDate: st.startDate,
      endDate: st.endDate,
      daysLeft: st.daysLeft,
      active: st.active,
      expired: st.expired,
      profileEdits: sub.profile_edits || 0,
      editsLeft: MAX_PROFILE_EDITS - (sub.profile_edits || 0),
      locked: (sub.profile_edits || 0) >= MAX_PROFILE_EDITS,
      hasProfile: !!sub.profile,
      selectedPlan: sub.selected_plan || null,
      // engagement snapshot
      status: m.status,
      daysSinceActivity: m.daysSinceActivity,
      daysSinceLogin: m.daysSinceLogin,
      loginCount: m.loginCount,
      completedCount: m.completedCount,
      completed30: m.completed30,
      adherencePct: m.adherencePct,
      volumeTrendPct: m.volumeTrendPct,
      totalVolume: m.totalVolume,
    };
  });
  res.json({ subscribers });
});

/* Full client file — everything known about one subscriber. */
app.get('/api/admin/subscribers/:id/profile', auth, requireAdmin, (req, res) => {
  const sub = stmts.findById.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'not found' });

  const st       = subscriptionStatus(sub);
  const metrics  = clientMetrics(sub);
  const progress = parseJson(sub.workout_progress, {});
  const activity = stmts.activityFor.all(sub.id, 60).map(a => ({
    event: a.event,
    meta: parseJson(a.meta, null),
    at: a.created_at,
  }));

  // Per-exercise history, newest first.
  const exercises = Object.entries(progress).map(([exId, entries]) => {
    const list = (Array.isArray(entries) ? entries : []).map(e => {
      const sets = Array.isArray(e.sets) ? e.sets
                 : (e.weight != null ? [{ w: e.weight, r: e.reps }] : []);
      return {
        at: new Date(e.date).getTime() || 0,
        sets,
        volume: Math.round(sets.reduce((a, s) => a + (Number(s.w)||0) * (Number(s.r)||0), 0)),
        maxW: sets.reduce((m, s) => Math.max(m, Number(s.w)||0), 0),
      };
    }).sort((a, b) => b.at - a.at);
    return {
      exerciseId: exId,
      sessions: list.length,
      best: list.reduce((m, s) => Math.max(m, s.maxW), 0),
      first: list.length ? list[list.length - 1] : null,
      last: list[0] || null,
      history: list.slice(0, 12),
    };
  }).sort((a, b) => b.sessions - a.sessions);

  res.json({
    subscriber: {
      id: sub.id,
      username: sub.username,
      fullName: sub.full_name,
      gender: sub.gender,
      phone: sub.phone || '',
      createdAt: sub.created_at,
      startDate: st.startDate,
      endDate: st.endDate,
      daysLeft: st.daysLeft,
      active: st.active,
      expired: st.expired,
      selectedPlan: sub.selected_plan || null,
      currentDay: sub.current_day || 0,
      editsLeft: MAX_PROFILE_EDITS - (sub.profile_edits || 0),
      locked: (sub.profile_edits || 0) >= MAX_PROFILE_EDITS,
    },
    profile: parseJson(sub.profile, null),
    macros:  parseJson(sub.macros, null),
    completedDays: parseJson(sub.completed_days, []),
    metrics,
    activity,
    exercises,
  });
});

/* Aggregated reports for the dashboard. */
app.get('/api/admin/reports', auth, requireAdmin, (_req, res) => {
  const rows = stmts.listAll.all();
  const now  = Date.now();

  const byStatus = {};
  let activeCount = 0, expiredCount = 0, expiringSoon = 0;
  let totalVolume30 = 0, sessions30 = 0, withProfile = 0;
  const needsAttention = [];
  const topPerformers  = [];

  for (const sub of rows) {
    const st = subscriptionStatus(sub);
    const m  = clientMetrics(sub);

    if (st.active) activeCount++; else expiredCount++;
    if (st.active && st.daysLeft <= 7) expiringSoon++;
    if (sub.profile) withProfile++;

    byStatus[m.status.key] = (byStatus[m.status.key] || 0) + 1;
    totalVolume30 += m.volume7;
    sessions30    += m.sessions30;

    const brief = {
      id: sub.id, fullName: sub.full_name, username: sub.username,
      phone: sub.phone || '', daysLeft: st.daysLeft,
      status: m.status, daysSinceActivity: m.daysSinceActivity,
      adherencePct: m.adherencePct, volumeTrendPct: m.volumeTrendPct,
      completed30: m.completed30,
    };

    // Only chase people whose subscription is still live.
    if (st.active && ['at_risk', 'stalled', 'never_logged_in', 'not_started'].includes(m.status.key))
      needsAttention.push(brief);
    if (st.active && m.completed30 > 0) topPerformers.push(brief);
  }

  const order = { stalled: 0, never_logged_in: 1, at_risk: 2, not_started: 3 };
  needsAttention.sort((a, b) => (order[a.status.key] ?? 9) - (order[b.status.key] ?? 9));
  topPerformers.sort((a, b) => b.completed30 - a.completed30 || (b.adherencePct||0) - (a.adherencePct||0));

  res.json({
    totals: {
      subscribers: rows.length,
      active: activeCount,
      expired: expiredCount,
      expiringSoon,
      withProfile,
      sessions30,
      volume7: Math.round(totalVolume30),
    },
    byStatus,
    needsAttention: needsAttention.slice(0, 20),
    topPerformers: topPerformers.slice(0, 10),
    generatedAt: now,
  });
});

app.post('/api/admin/subscribers', auth, requireAdmin, async (req, res) => {
  const { username, password, fullName, gender, months, phone } = req.body || {};
  if (!username || !password || !fullName)
    return res.status(400).json({ error: 'اسم المستخدم، كلمة المرور، والاسم الكامل مطلوبة' });

  const uname = username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,30}$/.test(uname))
    return res.status(400).json({ error: 'اسم المستخدم: أحرف إنجليزية وأرقام فقط (3-30 حرف)' });

  const existing = stmts.findByUsername.get(uname);
  if (existing) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });

  try {
    const now = Date.now();
    const durationMonths = Math.max(1, parseInt(months) || 1);
    const end = now + durationMonths * 30 * 86400000;
    const passwordHash = await bcrypt.hash(password, 10);
    const id = newId();
    const normPhone = normalizePhone(phone);

    stmts.insert.run(
      id, uname, passwordHash, fullName.trim(),
      gender === 'male' ? 'male' : 'female',
      normPhone || null,
      now, now, end
    );

    // Auto-send welcome message via WhatsApp Business API if configured
    let wa = { sent: false, reason: 'not_configured' };
    if (normPhone) {
      wa = await sendWhatsAppWelcome({
        phone: normPhone,
        fullName: fullName.trim(),
        username: uname,
        password,
      });
    }

    res.json({ ok: true, id, phone: normPhone, waSent: wa.sent, waReason: wa.reason });
  } catch (e) {
    console.error('create error:', e);
    res.status(500).json({ error: 'حدث خطأ في إنشاء الحساب' });
  }
});

// Send (or resend) the welcome message via WhatsApp Business API to an existing subscriber.
// Optionally resets the password first so the sent credentials are valid.
app.post('/api/admin/subscribers/:id/send-whatsapp', auth, requireAdmin, async (req, res) => {
  const sub = stmts.findById.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'not found' });
  if (!sub.phone) return res.status(400).json({ error: 'لا يوجد رقم جوال لهذا المشترك' });

  const { newPassword } = req.body || {};
  let plainPassword = newPassword;

  try {
    if (newPassword) {
      if (String(newPassword).length < 4)
        return res.status(400).json({ error: 'كلمة المرور: 4 أحرف على الأقل' });
      const hash = await bcrypt.hash(newPassword, 10);
      stmts.updatePassword.run(hash, sub.id);
    }

    const wa = await sendWhatsAppWelcome({
      phone: sub.phone,
      fullName: sub.full_name,
      username: sub.username,
      password: plainPassword || '(كلمة المرور الحالية — لم تتغيّر)',
    });

    res.json({ ok: true, waSent: wa.sent, waReason: wa.reason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lets the admin dashboard know whether auto-send is configured, to tailor the UI.
app.get('/api/admin/whatsapp-status', auth, requireAdmin, (_req, res) => {
  res.json({ enabled: WA_ENABLED });
});

app.patch('/api/admin/subscribers/:id', auth, requireAdmin, async (req, res) => {
  const { newPassword, extendMonths, active, resetEdits, fullName, phone } = req.body || {};
  const sub = stmts.findById.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'not found' });

  let changed = false;
  try {
    if (newPassword) {
      const hash = await bcrypt.hash(newPassword, 10);
      stmts.updatePassword.run(hash, sub.id);
      changed = true;
    }
    if (fullName) {
      stmts.updateFullName.run(fullName.trim(), sub.id);
      changed = true;
    }
    if (phone !== undefined) {
      stmts.updatePhone.run(normalizePhone(phone) || null, sub.id);
      changed = true;
    }
    if (active !== undefined) {
      stmts.updateActive.run(active ? 1 : 0, sub.id);
      changed = true;
    }
    if (resetEdits) {
      stmts.resetEdits.run(sub.id);
      changed = true;
    }
    if (extendMonths) {
      const currentEnd = sub.end_date || Date.now();
      const base = Math.max(currentEnd, Date.now());
      const newEnd = base + parseInt(extendMonths) * 30 * 86400000;
      stmts.updateEndDate.run(newEnd, sub.id);
      changed = true;
    }
    if (!changed) return res.status(400).json({ error: 'لا يوجد تحديثات' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/subscribers/:id', auth, requireAdmin, (req, res) => {
  const result = stmts.delete.run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not found' });
  stmts.deleteActivityFor.run(req.params.id); // don't leave orphaned activity rows
  res.json({ ok: true });
});

/* ═══════════════════════════════════════
   EXERCISE VIDEOS — uploaded files + YouTube URLs
═══════════════════════════════════════ */
const YT_FILE = path.join(VIDEO_DIR, 'youtube.json');
const YT_SEED = path.join(__dirname, 'youtube-seed.json');

// Seed youtube.json from repo defaults if missing — merges seed into runtime,
// preserving any admin-edited entries (existing keys win over seed).
try {
  if (fs.existsSync(YT_SEED)) {
    const seed = JSON.parse(fs.readFileSync(YT_SEED, 'utf8'));
    const current = fs.existsSync(YT_FILE) ? JSON.parse(fs.readFileSync(YT_FILE, 'utf8')) : {};
    const merged = { ...seed, ...current };  // current wins on conflict
    fs.writeFileSync(YT_FILE, JSON.stringify(merged, null, 2));
    console.log(`✅ YouTube seed applied (${Object.keys(merged).length} exercises)`);
  }
} catch (e) { console.warn('youtube seed skipped:', e.message); }

function findVideo(id) {
  for (const ext of ['.mp4', '.webm', '.mov']) {
    const p = path.join(VIDEO_DIR, `${id}${ext}`);
    if (fs.existsSync(p)) return `/videos/${id}${ext}`;
  }
  return null;
}

function readYoutube() {
  if (!fs.existsSync(YT_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(YT_FILE, 'utf8')); }
  catch { return {}; }
}

function writeYoutube(data) {
  fs.writeFileSync(YT_FILE, JSON.stringify(data, null, 2));
}

// Accepts: youtu.be/ID, youtube.com/watch?v=ID, youtube.com/shorts/ID, youtube.com/embed/ID
function extractYoutubeId(url = '') {
  const patterns = [
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

// Public: list uploaded videos + YouTube URLs
app.get('/api/exercises/videos', (_req, res) => {
  const videos = {};
  const yt = readYoutube();
  const youtube = {};
  for (const id of VALID_EXERCISES) {
    const url = findVideo(id);
    if (url) videos[id] = url;
    if (yt[id]) youtube[id] = yt[id];
  }
  res.json({ videos, youtube });
});

// Admin: upload video for one exercise
app.post('/api/admin/exercises/:id/video', auth, requireAdmin, (req, res) => {
  if (!VALID_EXERCISES.has(req.params.id))
    return res.status(400).json({ error: 'invalid exercise id' });

  for (const ext of ['.mp4', '.webm', '.mov']) {
    const p = path.join(VIDEO_DIR, `${req.params.id}${ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  videoUpload.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    res.json({ ok: true, url: `/videos/${req.file.filename}` });
  });
});

// Admin: delete video
app.delete('/api/admin/exercises/:id/video', auth, requireAdmin, (req, res) => {
  if (!VALID_EXERCISES.has(req.params.id))
    return res.status(400).json({ error: 'invalid exercise id' });
  let removed = false;
  for (const ext of ['.mp4', '.webm', '.mov']) {
    const p = path.join(VIDEO_DIR, `${req.params.id}${ext}`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; }
  }
  res.json({ ok: removed });
});

// Admin: save YouTube URL for one exercise
app.post('/api/admin/exercises/:id/youtube', auth, requireAdmin, (req, res) => {
  if (!VALID_EXERCISES.has(req.params.id))
    return res.status(400).json({ error: 'invalid exercise id' });
  const { url } = req.body || {};
  const vid = extractYoutubeId(url || '');
  if (!vid) return res.status(400).json({ error: 'رابط يوتيوب غير صحيح' });
  const yt = readYoutube();
  yt[req.params.id] = vid;
  writeYoutube(yt);
  res.json({ ok: true, videoId: vid });
});

// Admin: bulk save YouTube URLs
app.post('/api/admin/exercises/youtube/bulk', auth, requireAdmin, (req, res) => {
  const { items } = req.body || {};
  if (!items || typeof items !== 'object') return res.status(400).json({ error: 'items required' });
  const yt = readYoutube();
  let saved = 0, skipped = 0;
  for (const [id, url] of Object.entries(items)) {
    if (!VALID_EXERCISES.has(id)) { skipped++; continue; }
    const vid = extractYoutubeId(url || '');
    if (!vid) { skipped++; continue; }
    yt[id] = vid;
    saved++;
  }
  writeYoutube(yt);
  res.json({ ok: true, saved, skipped });
});

// Admin: delete YouTube URL
app.delete('/api/admin/exercises/:id/youtube', auth, requireAdmin, (req, res) => {
  if (!VALID_EXERCISES.has(req.params.id))
    return res.status(400).json({ error: 'invalid exercise id' });
  const yt = readYoutube();
  const existed = !!yt[req.params.id];
  delete yt[req.params.id];
  writeYoutube(yt);
  res.json({ ok: existed });
});

/* ═══════════════════════════════════════
   ROUTES
═══════════════════════════════════════ */
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/app',   (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));

/* ═══════════════════════════════════════
   START
═══════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 UR PASS — http://localhost:${PORT}`));
