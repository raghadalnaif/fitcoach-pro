/* ═══════════════════════════════════════════════════════════
   UR PASS — Subscriber App
═══════════════════════════════════════════════════════════ */

const TOKEN_KEY = 'urpass_token';

/* ═══════════════ ARABIC NUMERAL HELPERS ═══════════════ */
// عرض الأرقام بالأرقام العربية-الهندية للمشتركين
const AR_DIGITS = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
function arNum(n) {
  if (n === null || n === undefined || n === '') return '';
  return String(n).replace(/[0-9]/g, d => AR_DIGITS[+d]);
}
// للأرقام الكبيرة مع الفواصل
function arNumFmt(n) {
  if (n === null || n === undefined || n === '') return '';
  return arNum(Number(n).toLocaleString('en-US'));
}
const state = {
  user: null,
  profile: null,
  macros: null,
  editsLeft: 3,
  locked: false,
  selectedPlan: null,
  currentDay: 0,
  completedDays: [],
  workoutProgress: {},
  videos: {},
  youtube: {},
};

/* ═══════════════ AUTH ═══════════════ */
if (!localStorage.getItem(TOKEN_KEY)) {
  location.href = '/';
}

function logout() {
  if (!confirm('تسجيل الخروج؟')) return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('urpass_user');
  location.href = '/';
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
      ...(opts.headers || {}),
    },
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 || (r.status === 403 && data.expired)) {
    localStorage.clear();
    location.href = '/';
    throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error(data.error || 'خطأ');
  return data;
}

function toast(msg, kind = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  setTimeout(() => t.classList.remove('show'), 2500);
}

/* ═══════════════ TABS ═══════════════ */
function switchTab(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
  document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (tab === 'meals') renderMeals();
  if (tab === 'workout') renderWorkoutPage();
}

/* ═══════════════ INIT ═══════════════ */
async function init() {
  try {
    // Load user + exercise videos in parallel
    const [me, vids] = await Promise.all([
      api('/api/me'),
      fetch('/api/exercises/videos').then(r => r.json()).catch(() => ({ videos: {} })),
    ]);
    state.user = me;
    state.profile = me.profile;
    state.macros  = me.macros;
    state.editsLeft = me.editsLeft;
    state.locked  = me.locked;
    state.selectedPlan   = me.selectedPlan;
    state.currentDay     = me.currentDay || 0;
    state.completedDays  = me.completedDays || [];
    state.workoutProgress = me.workoutProgress || {};
    state.videos  = vids.videos  || {};
    state.youtube = vids.youtube || {};

    // Header
    document.getElementById('daysLeftBadge').textContent = `${arNum(me.daysLeft)} يوم`;
    if (me.daysLeft <= 7) document.getElementById('daysLeftBadge').classList.add('warn');

    // Hero
    document.getElementById('heroName').textContent = me.fullName;
    document.getElementById('heroDays').textContent = arNum(me.daysLeft);
    if (me.macros) {
      document.getElementById('heroCal').textContent  = arNumFmt(me.macros.cal);
      document.getElementById('heroProt').textContent = arNum(me.macros.protein);
    }

    // Print header
    document.getElementById('printName').textContent = me.fullName;
    document.getElementById('printDate').textContent = new Date().toLocaleDateString('ar-EG');

    // Populate calc form if profile exists
    if (me.profile) fillCalcForm(me.profile);
    updateEditsBadge();

    // Select prior plan if any
    if (me.selectedPlan) renderPlanPicker(me.selectedPlan);
    else renderPlanPicker();

    // Render home widgets
    renderTodayCard();
    renderProgressCard();
  } catch (e) {
    console.error('init error:', e);
  }
}

function fillCalcForm(p) {
  document.querySelectorAll('#genderChips .chip').forEach(c =>
    c.classList.toggle('on', c.dataset.v === p.gender));
  document.querySelectorAll('#goalChips .chip').forEach(c =>
    c.classList.toggle('on', c.dataset.v === p.goal));
  document.getElementById('age').value    = p.age;
  document.getElementById('height').value = p.height;
  document.getElementById('weight').value = p.weight;
  document.getElementById('activity').value = p.activity;

  if (state.macros) {
    document.getElementById('rCal').textContent  = arNumFmt(state.macros.cal);
    document.getElementById('rProt').textContent = arNum(state.macros.protein);
    document.getElementById('rCarb').textContent = arNum(state.macros.carbs);
    document.getElementById('rFat').textContent  = arNum(state.macros.fat);
    document.getElementById('macrosResult').classList.add('show');
  }
}

function updateEditsBadge() {
  document.getElementById('editsBadge').textContent = `${arNum(state.editsLeft)}/٣ محاولات متبقية`;
  const warn = document.getElementById('editsWarning');
  const locked = document.getElementById('lockedBox');
  const content = document.getElementById('calcContent');

  if (state.locked) {
    lockedBox.style.display = 'block';
    content.style.display = 'none';
    return;
  }
  lockedBox.style.display = 'none';
  content.style.display = 'block';

  if (state.editsLeft <= 2) {
    warn.style.display = 'block';
    document.getElementById('editsCount').textContent = state.editsLeft;
    if (state.editsLeft === 1) warn.classList.add('danger');
  }
}

/* ═══════════════ CALCULATOR ═══════════════ */
// Chip selectors
document.querySelectorAll('#genderChips .chip').forEach(c => c.addEventListener('click', () => {
  document.querySelectorAll('#genderChips .chip').forEach(x => x.classList.remove('on'));
  c.classList.add('on');
}));
document.querySelectorAll('#goalChips .chip').forEach(c => c.addEventListener('click', () => {
  document.querySelectorAll('#goalChips .chip').forEach(x => x.classList.remove('on'));
  c.classList.add('on');
}));

document.getElementById('calcForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.locked) return;

  const gender = document.querySelector('#genderChips .chip.on')?.dataset.v;
  const goal   = document.querySelector('#goalChips .chip.on')?.dataset.v;
  const age    = parseInt(document.getElementById('age').value);
  const height = parseInt(document.getElementById('height').value);
  const weight = parseFloat(document.getElementById('weight').value);
  const activity = parseFloat(document.getElementById('activity').value);

  if (!gender || !goal || !age || !height || !weight) {
    toast('يرجى إكمال جميع الحقول', 'error');
    return;
  }

  // Mifflin-St Jeor
  const bmr = gender === 'male'
    ? 10*weight + 6.25*height - 5*age + 5
    : 10*weight + 6.25*height - 5*age - 161;
  const tdee = bmr * activity;
  let cal;
  if (goal === 'lose')       cal = Math.round(tdee - 500);
  else if (goal === 'gain')  cal = Math.round(tdee + 400);
  else                        cal = Math.round(tdee);

  // Macros
  const protPerKg = goal === 'gain' ? 2.0 : 1.8;
  const protein   = Math.round(weight * protPerKg);
  const fat       = Math.round(cal * 0.27 / 9);
  const carbs     = Math.round((cal - protein*4 - fat*9) / 4);

  const macros = { cal, protein, carbs, fat };
  const profile = { gender, goal, age, height, weight, activity };

  const btn = document.getElementById('calcBtn');
  btn.disabled = true;
  btn.textContent = 'جاري الحفظ...';

  try {
    const r = await api('/api/me/profile', {
      method: 'POST',
      body: JSON.stringify({ profile, macros }),
    });
    state.profile = profile;
    state.macros = macros;
    state.editsLeft = r.editsLeft;
    if (state.editsLeft === 0) state.locked = true;

    document.getElementById('rCal').textContent  = arNumFmt(cal);
    document.getElementById('rProt').textContent = arNum(protein);
    document.getElementById('rCarb').textContent = arNum(carbs);
    document.getElementById('rFat').textContent  = arNum(fat);
    document.getElementById('macrosResult').classList.add('show');
    document.getElementById('macrosResult').scrollIntoView({ behavior:'smooth', block:'center' });

    document.getElementById('heroCal').textContent  = arNumFmt(cal);
    document.getElementById('heroProt').textContent = arNum(protein);

    updateEditsBadge();
    toast('تم الحفظ — المتبقي ' + arNum(state.editsLeft) + ' محاولات');

    btn.textContent = 'احسب واحفظ';
    btn.disabled = false;
  } catch (e) {
    toast(e.message, 'error');
    btn.textContent = 'احسب واحفظ';
    btn.disabled = false;
  }
});

/* ═══════════════ MEAL PLAN TEMPLATE ═══════════════ */
// Base plan designed for 1500 cal — everything scales proportionally
const MEAL_BASE_CAL = 1500;

const MEAL_ICONS = {
  breakfast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
  lunch:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v18M8 12H5a2 2 0 01-2-2V4a1 1 0 011-1h6a1 1 0 011 1v6a2 2 0 01-2 2z"/><path d="M17 3c-2 0-3 2-3 5s1 5 3 5v8"/></svg>',
  snack:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20a8 8 0 100-16 8 8 0 000 16z"/><path d="M12 6v6l4 2"/></svg>',
  dinner:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>',
};

const MEAL_PLAN = [
  {
    id: 'breakfast', name: 'الفطور', time: 'صباحاً — بعد الاستيقاظ',
    options: [
      { title: 'خيار 1', items: [
          { n: '١ بيضة كاملة + ٢ بياض بيض', q: 115, u: 'غ (تقريباً)' },
          { n: 'خبز توست أسمر', q: 30, u: 'غ (شريحة)' },
          { n: 'طماطم + خيار', q: 0, u: 'بلا حد' },
        ], macros: { p: 24, c: 18, f: 10 } },
      { title: 'خيار 2', items: [
          { n: 'شوفان حبة كاملة — وزن جاف قبل الطبخ', q: 45, u: 'غ' },
          { n: 'زبادي يوناني خالي الدسم', q: 170, u: 'غ' },
          { n: 'توت مجمد أو طازج', q: 60, u: 'غ' },
          { n: 'قرفة للتحلية', q: 0, u: 'صفر سعرات' },
        ], macros: { p: 22, c: 45, f: 5 } },
      { title: 'خيار 3', items: [
          { n: '٢ بيضة كاملة + ١ بياض بيض', q: 130, u: 'غ (تقريباً)' },
          { n: 'فلفل + سبانخ + بصل (للعجة)', q: 0, u: 'بلا حد' },
          { n: 'زيت زيتون للطبخ', q: 5, u: 'مل — ملعقة صغيرة' },
        ], macros: { p: 21, c: 5, f: 14 } },
    ]
  },
  {
    id: 'lunch', name: 'الغداء — الوجبة الكبرى', time: 'ظهراً — أهم وجبة',
    options: [
      { title: 'خيار 1', items: [
          { n: 'صدر دجاج مشوي — وزن بعد الطبخ', q: 120, u: 'غ' },
          { n: 'أرز بني — وزن بعد الطبخ', q: 130, u: 'غ' },
          { n: 'زيت زيتون للطبخ', q: 5, u: 'مل — ملعقة صغيرة' },
          { n: 'سلطة خضراء أو خضار مشوية', q: 0, u: 'بلا حد' },
        ], macros: { p: 39, c: 42, f: 12 } },
      { title: 'خيار 2', items: [
          { n: 'سلمون مشوي — وزن بعد الطبخ', q: 110, u: 'غ' },
          { n: 'برغل — وزن بعد الطبخ', q: 130, u: 'غ' },
          { n: 'ليمون + ثوم + بهارات', q: 0, u: 'صفر سعرات' },
          { n: 'طماطم + خيار + بقدونس', q: 0, u: 'بلا حد' },
        ], macros: { p: 30, c: 40, f: 16 } },
      { title: 'خيار 3', items: [
          { n: 'صدر دجاج مسلوق — وزن بعد الطبخ', q: 120, u: 'غ' },
          { n: 'بطاطس مسلوقة بالكمون — بعد الطبخ', q: 170, u: 'غ' },
          { n: 'زيت زيتون + ليمون', q: 8, u: 'مل — ملعقة كبيرة' },
          { n: 'خضار مشوية أو سلطة', q: 0, u: 'بلا حد' },
        ], macros: { p: 32, c: 32, f: 12 } },
    ]
  },
  {
    id: 'snack', name: 'سناك العصر', time: 'بعد الظهر — قبل أو بعد التمرين',
    options: [
      { title: 'خيار 1', items: [
          { n: 'زبادي يوناني خالي الدسم', q: 170, u: 'غ' },
          { n: 'تفاحة صغيرة أو توت', q: 90, u: 'غ' },
        ], macros: { p: 19, c: 22, f: 0 } },
      { title: 'خيار 2', items: [
          { n: 'تمر (حبات صغيرة)', q: 24, u: '٢ حبة' },
          { n: 'لوز نيء', q: 12, u: '٦ حبة' },
        ], macros: { p: 4, c: 22, f: 8 } },
      { title: 'خيار 3', items: [
          { n: 'حليب قليل الدسم', q: 250, u: 'مل — كوب' },
          { n: 'موزة صغيرة', q: 90, u: 'غ (حبة صغيرة)' },
        ], macros: { p: 12, c: 32, f: 4 } },
    ]
  },
  {
    id: 'dinner', name: 'العشاء', time: 'مساءً — قبل النوم بساعتين',
    options: [
      { title: 'خيار 1', items: [
          { n: 'لحم بقر مفروم خالي الدهون — وزن نيء', q: 110, u: 'غ' },
          { n: 'بطاطس حلوة مشوية — بعد الطبخ', q: 130, u: 'غ' },
          { n: 'بهارات: كمون + كركم + ثوم', q: 0, u: 'صفر سعرات' },
        ], macros: { p: 29, c: 30, f: 12 } },
      { title: 'خيار 2', items: [
          { n: 'صدر دجاج مشوي أو مسلوق — بعد الطبخ', q: 110, u: 'غ' },
          { n: 'برغل — وزن بعد الطبخ', q: 100, u: 'غ' },
          { n: 'زيت زيتون + ليمون', q: 5, u: 'مل — ملعقة صغيرة' },
          { n: 'طماطم + خيار + بقدونس', q: 0, u: 'بلا حد' },
        ], macros: { p: 32, c: 27, f: 8 } },
      { title: 'خيار 3', items: [
          { n: 'تونة بالماء — بعد التصفية من الماء', q: 110, u: 'غ' },
          { n: 'خبز توست أسمر', q: 30, u: 'غ (شريحة)' },
          { n: 'أفوكادو', q: 45, u: 'غ' },
          { n: 'طماطم + خيار + بقدونس', q: 0, u: 'بلا حد' },
        ], macros: { p: 30, c: 18, f: 14 } },
    ]
  },
];

function renderMeals() {
  const empty = document.getElementById('mealsEmpty');
  const content = document.getElementById('mealsContent');
  if (!state.macros) {
    empty.style.display = 'block';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = 'block';

  const scale = state.macros.cal / MEAL_BASE_CAL;

  // Summary
  document.getElementById('mealSummary').innerHTML = `
    <div class="ms-card"><div class="ms-val">${arNumFmt(state.macros.cal)}</div><div class="ms-lbl">سعرة/يوم</div></div>
    <div class="ms-card"><div class="ms-val">${arNum(state.macros.protein)}غ</div><div class="ms-lbl">بروتين</div></div>
    <div class="ms-card"><div class="ms-val">${arNum(state.macros.carbs)}غ</div><div class="ms-lbl">كارب</div></div>
    <div class="ms-card"><div class="ms-val">${arNum(state.macros.fat)}غ</div><div class="ms-lbl">دهون</div></div>
  `;

  // Meals list
  document.getElementById('mealsList').innerHTML = MEAL_PLAN.map((meal, mi) => {
    const opts = meal.options.map(opt => {
      const items = opt.items.map(it => {
        if (it.q === 0) return `<li class="opt-item"><span class="opt-item-name">${it.n}</span><span class="opt-item-qty">${it.u}</span></li>`;
        const scaledQ = Math.round(it.q * scale);
        return `<li class="opt-item"><span class="opt-item-name">${it.n}</span><span class="opt-item-qty">${arNum(scaledQ)} ${it.u}</span></li>`;
      }).join('');

      const p = Math.round(opt.macros.p * scale);
      const c = Math.round(opt.macros.c * scale);
      const f = Math.round(opt.macros.f * scale);
      const cal = p*4 + c*4 + f*9;

      return `
        <div class="opt-box">
          <div class="opt-title">${opt.title} <span class="opt-cal">~${arNum(cal)}ك</span></div>
          <ul class="opt-items">${items}</ul>
          <div class="opt-macros">
            <div class="opt-macro"><div class="opt-macro-val">${arNum(p)}غ</div><div class="opt-macro-lbl">بروتين</div></div>
            <div class="opt-macro"><div class="opt-macro-val">${arNum(c)}غ</div><div class="opt-macro-lbl">كارب</div></div>
            <div class="opt-macro"><div class="opt-macro-val">${arNum(f)}غ</div><div class="opt-macro-lbl">دهون</div></div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="meal-block">
        <div class="meal-head">
          <div class="meal-head-left">
            <div class="meal-icon">${MEAL_ICONS[meal.id] || ''}</div>
            <div>
              <div class="meal-name">${meal.name}</div>
              <div class="meal-time">${meal.time}</div>
            </div>
          </div>
          <div class="meal-tag">MEAL ${arNum('0' + (mi+1))}</div>
        </div>
        <div class="options-grid">${opts}</div>
      </div>`;
  }).join('');
}

/* ═══════════════ WORKOUT TEMPLATES ═══════════════ */
// Exercise DB — muscles, sets, reps, YouTube search query for videos
const EX = {
  // Chest
  bench_press:      { ar: 'بنش برس', en: 'Barbell Bench Press', m: 'صدر', ico: '' },
  db_bench:         { ar: 'بنش دمبل', en: 'Dumbbell Bench Press', m: 'صدر', ico: '' },
  incline_press:    { ar: 'بنش مائل', en: 'Incline Dumbbell Press', m: 'صدر علوي', ico: '' },
  pushup:           { ar: 'بوش أب', en: 'Push Up', m: 'صدر', ico: '' },

  // Back
  pullup:           { ar: 'بول أب', en: 'Pull Up', m: 'ظهر', ico: '' },
  lat_pulldown:     { ar: 'لات بولداون', en: 'Lat Pulldown', m: 'ظهر', ico: '' },
  bb_row:           { ar: 'بار رو', en: 'Barbell Row', m: 'ظهر', ico: '' },
  db_row:           { ar: 'دمبل رو', en: 'Dumbbell Row', m: 'ظهر', ico: '' },
  cable_row:        { ar: 'كيبل رو', en: 'Cable Row', m: 'ظهر', ico: '' },
  face_pull:        { ar: 'فيس بول', en: 'Face Pull', m: 'ظهر علوي', ico: '' },

  // Shoulders
  ohp:              { ar: 'شولدر برس', en: 'Overhead Shoulder Press', m: 'أكتاف', ico: '' },
  lateral_raise:    { ar: 'لاترال ريز', en: 'Lateral Raise', m: 'أكتاف جانبية', ico: '' },

  // Arms
  bicep_curl:       { ar: 'بايسبس دمبل', en: 'Dumbbell Bicep Curl', m: 'بايسبس', ico: '' },
  hammer_curl:      { ar: 'هامر كيرل', en: 'Hammer Curl', m: 'بايسبس', ico: '' },
  tricep_dip:       { ar: 'ديبس', en: 'Tricep Dips', m: 'ترايسبس', ico: '' },
  tricep_ext:       { ar: 'ترايسبس إكستنشن', en: 'Tricep Extension', m: 'ترايسبس', ico: '' },

  // Legs / Glutes
  squat:            { ar: 'باربل سكوات', en: 'Barbell Squat', m: 'أرجل', ico: '' },
  goblet_squat:     { ar: 'جوبلت سكوات', en: 'Goblet Squat', m: 'أرجل', ico: '' },
  sumo_squat:       { ar: 'سومو سكوات', en: 'Sumo Squat', m: 'أرجل داخلية + جلوت', ico: '' },
  bulgarian:        { ar: 'بلغاريان سكوات', en: 'Bulgarian Split Squat', m: 'أرجل + جلوت', ico: '' },
  lunges:           { ar: 'لانجز', en: 'Walking Lunges', m: 'أرجل', ico: '' },
  rdl:              { ar: 'رومانيان ديدلفت', en: 'Romanian Deadlift', m: 'ظهر سفلي + جلوت', ico: '' },
  deadlift:         { ar: 'ديدلفت', en: 'Deadlift', m: 'كامل الجسم', ico: '' },
  hip_thrust:       { ar: 'هيب ثراست', en: 'Hip Thrust', m: 'جلوت', ico: '' },
  glute_bridge:     { ar: 'جلوت بريدج', en: 'Glute Bridge', m: 'جلوت', ico: '' },
  cable_kickback:   { ar: 'كيبل كيك باك', en: 'Cable Glute Kickback', m: 'جلوت', ico: '' },
  leg_press:        { ar: 'ليج برس', en: 'Leg Press', m: 'أرجل', ico: '' },
  leg_curl:         { ar: 'ليج كيرل', en: 'Leg Curl', m: 'خلفية الفخذ', ico: '' },
  leg_ext:          { ar: 'ليج إكستنشن', en: 'Leg Extension', m: 'أمامية الفخذ', ico: '' },
  calf_raise:       { ar: 'كاف ريز', en: 'Calf Raise', m: 'سمانة', ico: '' },

  // Core
  plank:            { ar: 'بلانك', en: 'Plank', m: 'كور', ico: '' },
  russian_twist:    { ar: 'روسيان تويست', en: 'Russian Twist', m: 'كور جانبي', ico: '' },
  leg_raise:        { ar: 'ليج ريز', en: 'Hanging Leg Raise', m: 'بطن سفلي', ico: '' },
};

// Attach a set scheme: {sets, reps}
function ex(id, sets, reps) { return { id, sets, reps }; }

// 6 PLANS
const PLANS = {
  'female-3': {
    name: 'جدول البنات — 3 أيام',
    days: [
      { name: 'اليوم 1 — أرجل وجلوت', list: [
        ex('hip_thrust', 4, '10-12'),
        ex('goblet_squat', 4, '12'),
        ex('rdl', 3, '12'),
        ex('bulgarian', 3, '10 لكل رجل'),
        ex('calf_raise', 3, '15'),
      ]},
      { name: 'اليوم 2 — علوي', list: [
        ex('db_bench', 3, '12'),
        ex('lat_pulldown', 4, '12'),
        ex('ohp', 3, '10'),
        ex('bicep_curl', 3, '12'),
        ex('tricep_ext', 3, '12'),
      ]},
      { name: 'اليوم 3 — كامل + كور', list: [
        ex('deadlift', 3, '8-10'),
        ex('lunges', 3, '10 لكل رجل'),
        ex('cable_row', 3, '12'),
        ex('plank', 3, '45 ثانية'),
        ex('russian_twist', 3, '20'),
      ]},
    ]
  },
  'female-4': {
    name: 'جدول البنات — 4 أيام',
    days: [
      { name: 'اليوم 1 — جلوت', list: [
        ex('hip_thrust', 4, '10-12'),
        ex('sumo_squat', 4, '12'),
        ex('cable_kickback', 3, '15 لكل رجل'),
        ex('bulgarian', 3, '10 لكل رجل'),
        ex('glute_bridge', 3, '15'),
      ]},
      { name: 'اليوم 2 — علوي', list: [
        ex('db_bench', 4, '10-12'),
        ex('lat_pulldown', 4, '12'),
        ex('ohp', 3, '10'),
        ex('lateral_raise', 3, '15'),
        ex('bicep_curl', 3, '12'),
      ]},
      { name: 'اليوم 3 — أرجل', list: [
        ex('squat', 4, '10'),
        ex('rdl', 3, '12'),
        ex('leg_curl', 3, '12'),
        ex('leg_ext', 3, '15'),
        ex('calf_raise', 4, '20'),
      ]},
      { name: 'اليوم 4 — كامل + كور', list: [
        ex('deadlift', 3, '8'),
        ex('lunges', 3, '12 لكل رجل'),
        ex('db_row', 3, '12'),
        ex('plank', 3, '45 ثانية'),
        ex('russian_twist', 3, '20'),
      ]},
    ]
  },
  'female-5': {
    name: 'جدول البنات — 5 أيام',
    days: [
      { name: 'اليوم 1 — جلوت', list: [
        ex('hip_thrust', 4, '10-12'),
        ex('squat', 4, '10'),
        ex('rdl', 4, '10'),
        ex('cable_kickback', 3, '15 لكل رجل'),
        ex('glute_bridge', 3, '15'),
      ]},
      { name: 'اليوم 2 — ظهر + بايسبس', list: [
        ex('lat_pulldown', 4, '12'),
        ex('bb_row', 3, '10'),
        ex('cable_row', 3, '12'),
        ex('face_pull', 3, '15'),
        ex('bicep_curl', 3, '12'),
      ]},
      { name: 'اليوم 3 — أرجل أمامية', list: [
        ex('goblet_squat', 4, '12'),
        ex('leg_press', 4, '12'),
        ex('lunges', 3, '10 لكل رجل'),
        ex('leg_ext', 3, '15'),
        ex('calf_raise', 4, '20'),
      ]},
      { name: 'اليوم 4 — أكتاف + صدر', list: [
        ex('db_bench', 4, '10'),
        ex('ohp', 4, '10'),
        ex('lateral_raise', 4, '15'),
        ex('pushup', 3, 'للفشل'),
        ex('tricep_ext', 3, '12'),
      ]},
      { name: 'اليوم 5 — كامل + كور', list: [
        ex('deadlift', 4, '6-8'),
        ex('bulgarian', 3, '10 لكل رجل'),
        ex('db_row', 3, '12'),
        ex('plank', 3, '60 ثانية'),
        ex('russian_twist', 3, '20'),
      ]},
    ]
  },

  'male-3': {
    name: 'جدول الرجال — 3 أيام (Full Body)',
    days: [
      { name: 'اليوم 1 — Push', list: [
        ex('bench_press', 4, '8-10'),
        ex('ohp', 3, '10'),
        ex('incline_press', 3, '10'),
        ex('tricep_dip', 3, '12'),
        ex('lateral_raise', 3, '15'),
      ]},
      { name: 'اليوم 2 — Pull', list: [
        ex('pullup', 4, '6-8'),
        ex('bb_row', 4, '10'),
        ex('cable_row', 3, '12'),
        ex('face_pull', 3, '15'),
        ex('bicep_curl', 3, '10'),
      ]},
      { name: 'اليوم 3 — Legs', list: [
        ex('squat', 4, '8-10'),
        ex('rdl', 3, '10'),
        ex('leg_press', 3, '12'),
        ex('leg_curl', 3, '12'),
        ex('calf_raise', 4, '15'),
      ]},
    ]
  },
  'male-4': {
    name: 'جدول الرجال — 4 أيام (Upper/Lower)',
    days: [
      { name: 'اليوم 1 — Upper A', list: [
        ex('bench_press', 4, '8'),
        ex('bb_row', 4, '8'),
        ex('ohp', 3, '10'),
        ex('bicep_curl', 3, '10'),
        ex('tricep_ext', 3, '12'),
      ]},
      { name: 'اليوم 2 — Lower A', list: [
        ex('squat', 4, '6-8'),
        ex('rdl', 3, '10'),
        ex('leg_curl', 3, '12'),
        ex('calf_raise', 4, '15'),
      ]},
      { name: 'اليوم 3 — Upper B', list: [
        ex('incline_press', 4, '10'),
        ex('pullup', 4, '8'),
        ex('lat_pulldown', 3, '12'),
        ex('lateral_raise', 3, '15'),
        ex('hammer_curl', 3, '12'),
      ]},
      { name: 'اليوم 4 — Lower B', list: [
        ex('deadlift', 4, '5'),
        ex('lunges', 3, '10 لكل رجل'),
        ex('leg_ext', 3, '15'),
        ex('leg_press', 3, '12'),
      ]},
    ]
  },
  'male-5': {
    name: 'جدول الرجال — 5 أيام (PPL + Upper/Lower)',
    days: [
      { name: 'اليوم 1 — Push', list: [
        ex('bench_press', 4, '6-8'),
        ex('ohp', 4, '8'),
        ex('incline_press', 3, '10'),
        ex('lateral_raise', 4, '15'),
        ex('tricep_ext', 3, '12'),
      ]},
      { name: 'اليوم 2 — Pull', list: [
        ex('deadlift', 4, '5'),
        ex('pullup', 4, '8'),
        ex('bb_row', 3, '10'),
        ex('face_pull', 3, '15'),
        ex('bicep_curl', 4, '10'),
      ]},
      { name: 'اليوم 3 — Legs', list: [
        ex('squat', 4, '8'),
        ex('rdl', 3, '10'),
        ex('leg_press', 3, '12'),
        ex('leg_curl', 3, '12'),
        ex('calf_raise', 4, '20'),
      ]},
      { name: 'اليوم 4 — Upper', list: [
        ex('db_bench', 4, '10'),
        ex('cable_row', 4, '12'),
        ex('lateral_raise', 3, '15'),
        ex('hammer_curl', 3, '12'),
        ex('tricep_dip', 3, '12'),
      ]},
      { name: 'اليوم 5 — Lower + Core', list: [
        ex('bulgarian', 3, '10 لكل رجل'),
        ex('goblet_squat', 3, '12'),
        ex('leg_ext', 3, '15'),
        ex('plank', 3, '60 ثانية'),
        ex('leg_raise', 3, '12'),
      ]},
    ]
  },
};

function renderPlanPicker(active = null) {
  const gender = state.user?.gender || 'female';
  const plans = ['3', '4', '5'].map(d => {
    const key = `${gender}-${d}`;
    const isOn = active === key;
    return `
      <div class="plan-card ${isOn ? 'on' : ''}" onclick="selectPlan('${key}')">
        <div class="plan-check"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></div>
        <div class="plan-card-days">${d}</div>
        <div class="plan-card-lbl">أيام / أسبوع</div>
      </div>`;
  }).join('');
  document.getElementById('planPicker').innerHTML = plans;

  if (active) renderWorkoutDays(active);
}

async function selectPlan(key) {
  state.selectedPlan = key;
  state.currentDay = 0;
  renderPlanPicker(key);
  document.getElementById('workoutContent').style.display = 'block';
  try {
    await api('/api/me/plan', { method:'POST', body:JSON.stringify({ selectedPlan: key }) });
  } catch (e) { /* silent */ }
}

function renderWorkoutPage() {
  if (state.selectedPlan) {
    renderPlanPicker(state.selectedPlan);
    document.getElementById('workoutContent').style.display = 'block';
    renderWorkoutDays(state.selectedPlan);
  } else {
    renderPlanPicker();
  }
}

function renderWorkoutDays(planKey) {
  const plan = PLANS[planKey];
  if (!plan) return;
  // Ensure currentDay is within bounds
  if (state.currentDay >= plan.days.length) state.currentDay = 0;
  const tabs = plan.days.map((d, i) => {
    const doneToday = state.completedDays.some(cd => {
      if (cd.dayIdx !== i) return false;
      const t = new Date();
      return new Date(cd.date).toDateString() === t.toDateString();
    });
    return `<div class="day-tab ${i === state.currentDay ? 'on' : ''} ${doneToday ? 'done' : ''}"
             onclick="switchDay(${i})">يوم ${arNum(i+1)}${doneToday ? ' ✓' : ''}</div>`;
  }).join('');
  document.getElementById('dayTabs').innerHTML = tabs;
  renderDay(planKey, state.currentDay);
}

function switchDay(i) {
  state.currentDay = i;
  renderWorkoutDays(state.selectedPlan);
}

/* الكارديو حسب هدف المشترك */
function cardioForDay(dayIdx) {
  const goal = state.profile?.goal || 'maintain';
  const base = { lose: 25, maintain: 15, gain: 10 }[goal];
  const options = [
    { type: 'مشي سريع', pace: 'وتيرة مريحة', icon: 'walk' },
    { type: 'ركض خفيف', pace: 'وتيرة متوسطة', icon: 'run' },
    { type: 'دراجة ثابتة', pace: 'مقاومة خفيفة', icon: 'bike' },
    { type: 'إليبتيكال', pace: 'وتيرة ثابتة', icon: 'ellip' },
    { type: 'حبل قفز', pace: '30ث نشاط + 30ث راحة', icon: 'rope' },
  ];
  const pick = options[dayIdx % options.length];
  const note = goal === 'lose'   ? 'ضروري لخسارة الوزن'
             : goal === 'gain'   ? 'اختياري — للتخفيف نصف المدة'
             : 'موصى به للياقة القلبية';
  return { ...pick, minutes: base, note, goal };
}

function renderDay(planKey, idx) {
  const plan = PLANS[planKey];
  const day = plan.days[idx];
  document.getElementById('daySummary').innerHTML = `
    <div>
      <div class="day-title">${day.name}</div>
      <div class="day-count">${arNum(day.list.length)} تمارين + كارديو</div>
    </div>
  `;
  const exercisesHtml = day.list.map(item => {
    const e = EX[item.id];
    if (!e) return '';
    const last = state.workoutProgress[item.id]?.slice(-1)[0];
    // Normalize last session to sets array (handle legacy weight/reps entries)
    const lastSets = last
      ? (Array.isArray(last.sets) ? last.sets
         : (last.weight != null ? [{ w: last.weight, r: last.reps }] : []))
      : [];
    const videoUrl = state.videos[item.id];
    const ytId     = state.youtube[item.id];
    const hasAny   = videoUrl || ytId;
    let preview;
    if (videoUrl) {
      preview = `<video class="ex-video-inline" src="${videoUrl}" muted loop playsinline autoplay preload="metadata"></video>`;
    } else if (ytId) {
      preview = `<img src="https://i.ytimg.com/vi/${ytId}/hqdefault.jpg" class="ex-video-inline" alt="">`;
    } else {
      preview = `<svg class="ex-img-placeholder" viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg>`;
    }
    const watchLabel = hasAny
      ? '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg> مشاهدة الفيديو'
      : '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg> لا يوجد فيديو بعد';

    // Build set input rows
    const setsCount = parseInt(item.sets) || 3;
    const setsRows = Array.from({ length: setsCount }).map((_, i) => {
      const prev = lastSets[i];
      const prevHint = prev
        ? `<span class="set-prev">آخر مرة ${arNum(prev.w)}×${arNum(prev.r)}</span>`
        : `<span class="set-prev muted">— لم يُسجّل</span>`;
      return `
        <div class="set-row">
          <div class="set-num">${arNum(i + 1)}</div>
          <input type="number" inputmode="decimal" step="0.5" class="set-input" data-ex="${item.id}" data-kind="w" data-i="${i}" placeholder="وزن" value="">
          <span class="set-x">×</span>
          <input type="number" inputmode="numeric" class="set-input" data-ex="${item.id}" data-kind="r" data-i="${i}" placeholder="تكرار" value="">
          ${prevHint}
        </div>`;
    }).join('');

    const historyCount = state.workoutProgress[item.id]?.length || 0;

    return `
      <div class="ex-card">
        <div class="ex-head">
          <div class="ex-img-wrap" onclick="openExVideo('${item.id}')">
            ${preview}
            <div class="ex-play"><svg class="ico" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
          </div>
          <div class="ex-info">
            <div class="ex-name">${e.ar}</div>
            <div class="ex-name-en">${e.en}</div>
            <div class="ex-muscle">${e.m}</div>
            <div class="ex-scheme">
              <div>مجموعات: <b>${arNum(item.sets)}</b></div>
              <div>تكرارات: <b>${arNum(item.reps)}</b></div>
            </div>
          </div>
        </div>
        <button class="btn-watch" onclick="openExVideo('${item.id}')">${watchLabel}</button>

        <div class="sets-wrap">
          <div class="sets-head">
            <div class="sets-title">سجل جولاتك</div>
            ${historyCount > 0 ? `<button class="btn-history" onclick="showExHistory('${item.id}')">
              <svg class="ico" viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M3 3v5h5"/><path d="M3.05 13a9 9 0 106.05-8.5"/><path d="M12 8v5l3 2"/></svg>
              التطور (${arNum(historyCount)})
            </button>` : ''}
          </div>
          ${setsRows}
          <button class="ex-save" onclick="saveExerciseSets('${item.id}')">
            <svg class="ico" viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
            حفظ الجلسة
          </button>
        </div>
      </div>`;
  }).join('');

  // Cardio at end of workout
  const c = cardioForDay(idx);
  const cardioIcons = {
    walk:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="M4 22l4-9 4 3 3 8M13 10l4 3 3-4 2 3"/></svg>',
    run:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="17" cy="4" r="2"/><path d="M3 22l4-8 5 2-2 6M12 16l4-4 3 3 2-4M8 12l2-4 4 1"/></svg>',
    bike:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="17" r="4"/><circle cx="18" cy="17" r="4"/><path d="M6 17l4-9h5l3 9M13 6h3"/></svg>',
    ellip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="18" rx="8" ry="2"/><path d="M12 16V4M8 8l8 6"/></svg>',
    rope:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M12 6v6M4 20c0-6 4-8 8-8s8 2 8 8"/></svg>',
  };
  const cardioHtml = `
    <div class="cardio-card">
      <div class="cardio-head">
        <div class="cardio-icon">${cardioIcons[c.icon]}</div>
        <div style="flex:1">
          <div class="cardio-title">كارديو بعد التمرين</div>
          <div class="cardio-note">${c.note}</div>
        </div>
        <div class="cardio-duration">${arNum(c.minutes)} <span>دقيقة</span></div>
      </div>
      <div class="cardio-body">
        <div class="cardio-row"><span class="cardio-lbl">النوع</span><span class="cardio-val">${c.type}</span></div>
        <div class="cardio-row"><span class="cardio-lbl">الوتيرة</span><span class="cardio-val">${c.pace}</span></div>
      </div>
    </div>`;

  // Check if this day was already completed today
  const doneToday = state.completedDays.some(cd => {
    if (cd.dayIdx !== idx) return false;
    return new Date(cd.date).toDateString() === new Date().toDateString();
  });

  const completeBtn = doneToday
    ? `<div class="complete-day-wrap" style="background:var(--surface2);color:var(--text);border:1.5px solid var(--green);box-shadow:none">
         <div class="complete-day-title" style="color:var(--green)">أنجزت تمرين اليوم</div>
         <div class="complete-day-sub" style="color:var(--muted);opacity:1">التمرين التالي سيظهر تلقائياً غداً</div>
       </div>`
    : `<div class="complete-day-wrap">
         <div class="complete-day-title">هل أنهيت التمرين؟</div>
         <div class="complete-day-sub">اضغط لتسجيل الإنجاز والانتقال لليوم التالي</div>
         <button class="btn-complete-day" onclick="completeToday()">
           <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
           تم إنجاز التمرين
         </button>
       </div>`;

  document.getElementById('exerciseList').innerHTML = exercisesHtml + cardioHtml + completeBtn;
}

async function saveExerciseSets(exId) {
  const inputs = document.querySelectorAll(`.set-input[data-ex="${exId}"]`);
  const setsMap = {};
  inputs.forEach(inp => {
    const i = inp.dataset.i;
    if (!setsMap[i]) setsMap[i] = { w: 0, r: 0 };
    setsMap[i][inp.dataset.kind] = Number(inp.value) || 0;
  });
  const sets = Object.values(setsMap).filter(s => s.w > 0 || s.r > 0);
  if (sets.length === 0) return toast('أدخل وزن أو تكرار في جولة واحدة على الأقل', 'error');
  try {
    await api('/api/me/progress', {
      method: 'POST',
      body: JSON.stringify({ exerciseId: exId, sets }),
    });
    if (!state.workoutProgress[exId]) state.workoutProgress[exId] = [];
    state.workoutProgress[exId].push({ date: new Date().toISOString(), sets });
    toast(`تم حفظ ${arNum(sets.length)} جولات`);
    renderDay(state.selectedPlan, state.currentDay);
  } catch (e) { toast(e.message, 'error'); }
}

function showExHistory(exId) {
  const e = EX[exId];
  const hist = state.workoutProgress[exId] || [];
  if (hist.length === 0) return toast('لا يوجد تسجيلات بعد');
  const rows = [...hist].reverse().map(entry => {
    const sets = Array.isArray(entry.sets) ? entry.sets
               : (entry.weight != null ? [{ w: entry.weight, r: entry.reps }] : []);
    const d = new Date(entry.date);
    const dateStr = d.toLocaleDateString('ar-EG', { day:'numeric', month:'short', year:'numeric' });
    const setsList = sets.map((s, i) =>
      `<span class="hist-set">${arNum(i+1)}: <b>${arNum(s.w)}×${arNum(s.r)}</b></span>`
    ).join('');
    const total = sets.reduce((a, s) => a + s.w * s.r, 0);
    return `
      <div class="hist-row">
        <div class="hist-date">${dateStr}</div>
        <div class="hist-sets">${setsList}</div>
        <div class="hist-total">حجم الرفعة: ${arNumFmt(total)} كجم</div>
      </div>`;
  }).join('');
  const frame = document.getElementById('videoFrame');
  const title = document.getElementById('videoTitle');
  const modal = document.getElementById('videoModal');
  if (title) title.textContent = 'تطور: ' + e.ar;
  frame.innerHTML = `<div class="history-scroll">${rows}</div>`;
  modal.classList.add('open');
}

function openExVideo(exId) {
  const url   = state.videos[exId];
  const ytId  = state.youtube[exId];
  const e     = EX[exId];
  const modal = document.getElementById('videoModal');
  const frame = document.getElementById('videoFrame');
  const title = document.getElementById('videoTitle');
  if (title) title.textContent = e ? e.ar : '';
  if (url) {
    frame.innerHTML = `<video src="${url}" controls autoplay playsinline style="width:100%;height:100%;background:#000"></video>`;
  } else if (ytId) {
    frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&rel=0&modestbranding=1" style="width:100%;height:100%;border:0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  } else {
    frame.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#fff;text-align:center;padding:20px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:56px;height:56px;margin-bottom:14px;opacity:.6"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg>
      <div style="font-size:16px;font-weight:800;margin-bottom:6px">لم يتم رفع الفيديو بعد</div>
      <div style="font-size:13px;opacity:.7">تواصل مع المدرب لإضافة فيديو الشرح</div>
    </div>`;
  }
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

/* ═══════════════ TODAY'S WORKOUT ═══════════════ */
function renderTodayCard() {
  const el = document.getElementById('todayCard');
  if (!el) return;

  if (!state.selectedPlan) {
    el.innerHTML = `
      <div class="today-card empty">
        <div class="today-empty-title">لم تختر جدولاً بعد</div>
        <div class="today-empty-sub">اختر جدول التمارين المناسب لك للبدء</div>
        <button class="btn-primary" onclick="switchTab('workout')">اختيار جدول</button>
      </div>`;
    return;
  }

  const plan = PLANS[state.selectedPlan];
  if (!plan) { el.innerHTML = ''; return; }

  const idx  = state.currentDay % plan.days.length;
  const day  = plan.days[idx];
  const c    = cardioForDay(idx);
  const completedToday = state.completedDays.some(cd => {
    if (cd.dayIdx !== idx) return false;
    const d = new Date(cd.date);
    const t = new Date();
    return d.toDateString() === t.toDateString();
  });

  el.innerHTML = `
    <div class="today-card ${completedToday ? 'done' : ''}">
      <div class="today-head">
        <div>
          <div class="today-eyebrow">تمرين اليوم</div>
          <div class="today-title">${day.name}</div>
        </div>
        <div class="today-day-badge">يوم ${arNum(idx + 1)} / ${arNum(plan.days.length)}</div>
      </div>
      <div class="today-meta">
        <div class="today-meta-item">
          <svg class="ico" viewBox="0 0 24 24"><path d="M6 4v16M4 6h4M4 18h4M18 4v16M16 6h4M16 18h4M8 12h8"/></svg>
          ${arNum(day.list.length)} تمارين
        </div>
        <div class="today-meta-item">
          <svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          كارديو ${arNum(c.minutes)} دقيقة
        </div>
      </div>
      ${completedToday
        ? `<div class="today-done-note">
             <svg class="ico" viewBox="0 0 24 24" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>
             أنجزت تمرين اليوم — عمل ممتاز
           </div>
           <button class="btn-outline" onclick="switchTab('workout')" style="width:100%">مراجعة التمرين</button>`
        : `<button class="btn-primary" onclick="startTodayWorkout()" style="width:100%">
             <svg class="ico" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>
             بدء التمرين
           </button>`
      }
    </div>`;
}

function startTodayWorkout() {
  if (!state.selectedPlan) return switchTab('workout');
  const plan = PLANS[state.selectedPlan];
  state.currentDay = state.currentDay % plan.days.length;
  switchTab('workout');
}

async function completeToday() {
  if (!state.selectedPlan) return;
  const plan = PLANS[state.selectedPlan];
  const totalDays = plan.days.length;
  try {
    const r = await api('/api/me/complete-day', {
      method: 'POST',
      body: JSON.stringify({ totalDays }),
    });
    // Record locally
    const prevIdx = state.currentDay;
    state.currentDay = r.currentDay;
    state.completedDays.push({ dayIdx: prevIdx, date: new Date().toISOString() });
    toast('أُنجز التمرين — التالي: يوم ' + arNum(r.currentDay + 1));
    renderTodayCard();
    renderProgressCard();
    switchTab('home');
  } catch (e) { toast(e.message, 'error'); }
}

/* ═══════════════ PROGRESS REPORT ═══════════════ */
function computeStats() {
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const prev14 = now - 14 * 86400000;

  let weekSessions = 0, weekVolume = 0, prevWeekVolume = 0;
  const prs = {}; // exId → best weight ever
  const prevBest = {}; // exId → best weight before last session

  for (const [exId, entries] of Object.entries(state.workoutProgress)) {
    if (!Array.isArray(entries)) continue;
    let bestEver = 0, bestPrev = 0;
    entries.forEach((entry, i) => {
      const t = new Date(entry.date).getTime();
      const sets = Array.isArray(entry.sets) ? entry.sets
                 : (entry.weight != null ? [{ w: entry.weight, r: entry.reps }] : []);
      const vol = sets.reduce((a, s) => a + (Number(s.w)||0) * (Number(s.r)||0), 0);
      const maxW = sets.reduce((m, s) => Math.max(m, Number(s.w)||0), 0);

      if (t >= weekAgo) { weekSessions++; weekVolume += vol; }
      else if (t >= prev14) { prevWeekVolume += vol; }

      if (i < entries.length - 1) bestPrev = Math.max(bestPrev, maxW);
      bestEver = Math.max(bestEver, maxW);
    });
    if (bestEver > 0) prs[exId] = bestEver;
    if (bestPrev > 0) prevBest[exId] = bestPrev;
  }

  // Recent PR gains (current PR - previous best)
  const gains = Object.entries(prs)
    .map(([id, curr]) => ({ id, curr, prev: prevBest[id] || 0, diff: curr - (prevBest[id] || 0) }))
    .filter(g => g.diff > 0)
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 3);

  const volumeChange = prevWeekVolume > 0
    ? Math.round(((weekVolume - prevWeekVolume) / prevWeekVolume) * 100)
    : (weekVolume > 0 ? 100 : 0);

  return { weekSessions, weekVolume, volumeChange, gains, totalExercises: Object.keys(prs).length };
}

function renderProgressCard() {
  const el = document.getElementById('progressCard');
  if (!el) return;
  const s = computeStats();

  if (s.weekSessions === 0 && s.totalExercises === 0) {
    el.innerHTML = `
      <div class="progress-card empty">
        <div class="progress-empty-title">لا يوجد تسجيلات بعد</div>
        <div class="progress-empty-sub">سجّل أوزانك في التمرين وستظهر إحصائياتك هنا</div>
      </div>`;
    return;
  }

  const changeIco = s.volumeChange >= 0
    ? '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/></svg>'
    : '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M23 18l-9.5-9.5-5 5L1 6"/><path d="M17 18h6v-6"/></svg>';
  const changeSign = s.volumeChange >= 0 ? '+' : '';

  const gainsHtml = s.gains.length > 0
    ? `<div class="progress-gains">
         <div class="progress-gains-title">أفضل تقدم</div>
         ${s.gains.map(g => {
           const e = EX[g.id];
           if (!e) return '';
           return `<div class="gain-row">
             <span class="gain-name">${e.ar}</span>
             <span class="gain-diff">+ ${arNum(g.diff)} كجم</span>
           </div>`;
         }).join('')}
       </div>`
    : '';

  el.innerHTML = `
    <div class="progress-card">
      <div class="progress-head">
        <div>
          <div class="progress-eyebrow">متابعة تطورك</div>
          <div class="progress-title">هذا الأسبوع</div>
        </div>
      </div>
      <div class="progress-stats">
        <div class="p-stat">
          <div class="p-stat-val">${arNum(s.weekSessions)}</div>
          <div class="p-stat-lbl">جلسة</div>
        </div>
        <div class="p-stat">
          <div class="p-stat-val">${arNumFmt(s.weekVolume)}</div>
          <div class="p-stat-lbl">كجم إجمالي</div>
        </div>
        <div class="p-stat ${s.volumeChange >= 0 ? 'up' : 'down'}">
          <div class="p-stat-val" style="display:flex;align-items:center;justify-content:center;gap:4px">
            <span style="width:14px;height:14px;display:inline-block">${changeIco}</span>
            ${changeSign}${arNum(Math.abs(s.volumeChange))}٪
          </div>
          <div class="p-stat-lbl">مقارنة بالأسبوع الماضي</div>
        </div>
      </div>
      ${gainsHtml}
    </div>`;
}

function closeVideo() {
  const frame = document.getElementById('videoFrame');
  if (frame) frame.innerHTML = '';
  document.getElementById('videoModal').classList.remove('open');
  document.body.style.overflow = '';
}

function videoBackdropClick(e) {
  if (e.target.id === 'videoModal') closeVideo();
}

// Esc to close video
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('videoModal')?.classList.contains('open')) {
    closeVideo();
  }
});

init();
