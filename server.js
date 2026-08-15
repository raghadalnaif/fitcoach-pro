require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const admin   = require('firebase-admin');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

/* ═══════════════════════════════════════
   FIREBASE
═══════════════════════════════════════ */
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
    db = admin.firestore();
    console.log('✅ Firebase connected');
  } else console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set');
} catch (e) { console.error('Firebase init error:', e.message); }

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

async function fetchSubscriber(id) {
  if (!db) throw new Error('db not configured');
  const snap = await db.collection('subscribers').doc(id).get();
  if (!snap.exists) throw new Error('not found');
  return { id: snap.id, ...snap.data() };
}

function subscriptionStatus(sub) {
  const now = Date.now();
  const end = sub.endDate?.toMillis ? sub.endDate.toMillis() : (sub.endDate || 0);
  const start = sub.startDate?.toMillis ? sub.startDate.toMillis() : (sub.startDate || 0);
  const active = sub.active !== false && end > now;
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));
  return { active, daysLeft, startDate: start, endDate: end, expired: end <= now };
}

/* ═══════════════════════════════════════
   PUBLIC — subscriber login
═══════════════════════════════════════ */
app.post('/api/login', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'db not configured' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });

  try {
    const snap = await db.collection('subscribers')
      .where('username', '==', username.trim().toLowerCase()).limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور خاطئة' });

    const doc  = snap.docs[0];
    const data = doc.data();
    const ok   = await bcrypt.compare(password, data.passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور خاطئة' });

    const status = subscriptionStatus(data);
    if (!status.active) {
      return res.status(403).json({
        error: 'انتهت مدة اشتراكك',
        expired: true,
        message: 'يرجى التواصل مع خدمة العملاء لتجديد الاشتراك'
      });
    }

    const token = signToken({ sub: doc.id, username: data.username });
    res.json({
      token,
      user: {
        id: doc.id,
        username: data.username,
        fullName: data.fullName,
        gender: data.gender,
        daysLeft: status.daysLeft,
        endDate: status.endDate,
        hasProfile: !!data.profile,
        editsLeft: MAX_PROFILE_EDITS - (data.profileEdits || 0),
        locked: (data.profileEdits || 0) >= MAX_PROFILE_EDITS,
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
app.get('/api/me', auth, requireSubscriber, async (req, res) => {
  try {
    const sub = await fetchSubscriber(req.user.sub);
    const status = subscriptionStatus(sub);
    if (!status.active) return res.status(403).json({ error: 'انتهى اشتراكك', expired: true });
    res.json({
      id: sub.id,
      username: sub.username,
      fullName: sub.fullName,
      gender: sub.gender,
      profile: sub.profile || null,
      macros: sub.macros || null,
      daysLeft: status.daysLeft,
      endDate: status.endDate,
      editsLeft: MAX_PROFILE_EDITS - (sub.profileEdits || 0),
      locked: (sub.profileEdits || 0) >= MAX_PROFILE_EDITS,
      workoutProgress: sub.workoutProgress || {},
      selectedPlan: sub.selectedPlan || null,
    });
  } catch { res.status(404).json({ error: 'not found' }); }
});

app.post('/api/me/profile', auth, requireSubscriber, async (req, res) => {
  const { profile, macros } = req.body || {};
  if (!profile || !macros) return res.status(400).json({ error: 'incomplete data' });
  try {
    const sub = await fetchSubscriber(req.user.sub);
    const edits = sub.profileEdits || 0;
    if (edits >= MAX_PROFILE_EDITS) {
      return res.status(403).json({
        error: 'وصلتِ للحد الأقصى من التعديلات',
        locked: true,
        message: 'يرجى التواصل مع خدمة العملاء لإعادة تفعيل الحسابة'
      });
    }
    await db.collection('subscribers').doc(req.user.sub).update({
      profile, macros,
      profileEdits: edits + 1,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, editsLeft: MAX_PROFILE_EDITS - (edits + 1) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/me/plan', auth, requireSubscriber, async (req, res) => {
  const { selectedPlan } = req.body || {};
  try {
    await db.collection('subscribers').doc(req.user.sub).update({ selectedPlan });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/me/progress', auth, requireSubscriber, async (req, res) => {
  const { exerciseId, weight, reps, date } = req.body || {};
  if (!exerciseId) return res.status(400).json({ error: 'exerciseId required' });
  try {
    const key = `workoutProgress.${exerciseId}`;
    await db.collection('subscribers').doc(req.user.sub).update({
      [key]: admin.firestore.FieldValue.arrayUnion({
        weight: Number(weight) || 0,
        reps: Number(reps) || 0,
        date: date || new Date().toISOString(),
      }),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════
   ADMIN — login + subscriber CRUD
═══════════════════════════════════════ */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'كلمة المرور خاطئة' });
  const token = signToken({ admin: true }, '7d');
  res.json({ token });
});

app.get('/api/admin/subscribers', auth, requireAdmin, async (_req, res) => {
  if (!db) return res.status(503).json({ error: 'db not configured' });
  try {
    const snap = await db.collection('subscribers').orderBy('createdAt', 'desc').get();
    const users = snap.docs.map(d => {
      const data = d.data();
      const st = subscriptionStatus(data);
      return {
        id: d.id,
        username: data.username,
        fullName: data.fullName,
        gender: data.gender,
        startDate: st.startDate,
        endDate: st.endDate,
        daysLeft: st.daysLeft,
        active: st.active,
        expired: st.expired,
        profileEdits: data.profileEdits || 0,
        editsLeft: MAX_PROFILE_EDITS - (data.profileEdits || 0),
        locked: (data.profileEdits || 0) >= MAX_PROFILE_EDITS,
        hasProfile: !!data.profile,
      };
    });
    res.json({ subscribers: users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/subscribers', auth, requireAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'db not configured' });
  const { username, password, fullName, gender, months } = req.body || {};
  if (!username || !password || !fullName)
    return res.status(400).json({ error: 'اسم المستخدم، كلمة المرور، والاسم الكامل مطلوبة' });

  const uname = username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,30}$/.test(uname))
    return res.status(400).json({ error: 'اسم المستخدم: أحرف إنجليزية وأرقام فقط (3-30 حرف)' });

  try {
    const existing = await db.collection('subscribers').where('username', '==', uname).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });

    const now = Date.now();
    const durationMonths = Math.max(1, parseInt(months) || 1);
    const end = now + durationMonths * 30 * 86400000;

    const passwordHash = await bcrypt.hash(password, 10);
    const doc = await db.collection('subscribers').add({
      username: uname,
      passwordHash,
      fullName: fullName.trim(),
      gender: gender === 'male' ? 'male' : 'female',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      startDate: admin.firestore.Timestamp.fromMillis(now),
      endDate: admin.firestore.Timestamp.fromMillis(end),
      active: true,
      profileEdits: 0,
    });
    res.json({ ok: true, id: doc.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/subscribers/:id', auth, requireAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'db not configured' });
  const { newPassword, extendMonths, active, resetEdits, fullName } = req.body || {};
  const updates = {};

  try {
    if (newPassword) updates.passwordHash = await bcrypt.hash(newPassword, 10);
    if (fullName)    updates.fullName     = fullName.trim();
    if (active !== undefined) updates.active = !!active;
    if (resetEdits)  updates.profileEdits  = 0;

    if (extendMonths) {
      const sub = await fetchSubscriber(req.params.id);
      const currentEnd = sub.endDate?.toMillis ? sub.endDate.toMillis() : Date.now();
      const base = Math.max(currentEnd, Date.now());
      const newEnd = base + parseInt(extendMonths) * 30 * 86400000;
      updates.endDate = admin.firestore.Timestamp.fromMillis(newEnd);
      updates.active  = true;
    }

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'لا يوجد تحديثات' });

    await db.collection('subscribers').doc(req.params.id).update(updates);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/subscribers/:id', auth, requireAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'db not configured' });
  try {
    await db.collection('subscribers').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════
   ROUTES for HTML pages
═══════════════════════════════════════ */
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/app',   (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));

/* ═══════════════════════════════════════
   START
═══════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 UR PASS — http://localhost:${PORT}`));
