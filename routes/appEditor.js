/* App editors: village members an admin trusts to post mandi rates and notices
   from the mobile app. Everything they post notifies app users.

   Granting a role creates a one-time 6-digit editor code (shown to the admin once).
   The person enters it in the app, which then gets an editor token. Visitor tokens
   alone are not enough, because older servers exposed them in public lists.
   Revoking roles or making a new code bumps editorVersion, which ends old sessions. */
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const router = express.Router();
const Visitor = require('../models/Visitor');
const Notice = require('../models/Notice');
const { MandiRate } = require('../models/Farmer');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const JWT_SECRET = require('../helpers/jwtSecret');

const APP_ROLES = { mandi: 'मंडी भाव', notice: 'सूचनाएं' };
const NOTICE_CATEGORIES = ['announcement', 'meeting', 'event', 'emergency', 'general'];
const MAX_ATTEMPTS = 5;

const hashCode = code => crypto.createHmac('sha256', JWT_SECRET).update(`editor:${code}`).digest('hex');
const newCode = () => String(crypto.randomInt(100000, 1000000));
const displayName = v => (v.registeredName || v.visitorName || 'गाँव वाले').trim();

// ── Editor auth ───────────────────────────────────────────────
async function editorAuth(req, res, next) {
  try {
    const token = String(req.header('Authorization') || '').replace('Bearer ', '');
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.kind !== 'app-editor') throw new Error('wrong token');
    const v = await Visitor.findById(decoded.vid).select('registeredName visitorName appRoles editorVersion');
    if (!v || v.editorVersion !== decoded.v || !v.appRoles.length) {
      return res.status(401).json({ message: 'एडिटर अनुमति हट गई है या बदल गई है। नया कोड डालें।', revoked: true });
    }
    req.editor = v;
    next();
  } catch {
    res.status(401).json({ message: 'एडिटर लॉगिन ज़रूरी है', revoked: true });
  }
}
const needRole = role => (req, res, next) =>
  req.editor.appRoles.includes(role) ? next() : res.status(403).json({ message: 'आपको यह अनुमति नहीं मिली है' });

// ── PUBLIC: activate with the code the admin gave ──────────────
router.post('/activate', async (req, res) => {
  try {
    const { visitorToken, code } = req.body;
    if (!visitorToken || !code) return res.status(400).json({ message: 'कोड डालें' });
    const v = await Visitor.findOne({ visitorToken }).select('+editorCodeHash registeredName visitorName appRoles editorVersion editorFailedAttempts editorLockedUntil');
    if (!v) return res.status(404).json({ message: 'पहले अपनी प्रोफ़ाइल बनाएं' });
    if (v.editorLockedUntil && v.editorLockedUntil > new Date()) {
      return res.status(429).json({ message: 'बहुत बार गलत कोड डाला गया। 30 मिनट बाद कोशिश करें।' });
    }
    const ok = v.appRoles.length && v.editorCodeHash &&
      crypto.timingSafeEqual(Buffer.from(hashCode(String(code).trim())), Buffer.from(v.editorCodeHash));
    if (!ok) {
      v.editorFailedAttempts = (v.editorFailedAttempts || 0) + 1;
      if (v.editorFailedAttempts >= MAX_ATTEMPTS) { v.editorLockedUntil = new Date(Date.now() + 30 * 60 * 1000); v.editorFailedAttempts = 0; }
      await v.save();
      return res.status(400).json({ message: 'कोड सही नहीं है, या इस प्रोफ़ाइल को एडिटर अनुमति नहीं मिली है।' });
    }
    v.editorFailedAttempts = 0;
    v.editorLockedUntil = undefined;
    await v.save();
    const editorToken = jwt.sign({ kind: 'app-editor', vid: String(v._id), v: v.editorVersion }, JWT_SECRET, { expiresIn: '365d' });
    res.json({ editorToken, roles: v.appRoles, name: displayName(v) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/me', editorAuth, (req, res) => {
  res.json({ roles: req.editor.appRoles, name: displayName(req.editor), labels: APP_ROLES });
});

// ── Mandi rates ────────────────────────────────────────────────
router.post('/mandi-rates', editorAuth, needRole('mandi'), async (req, res) => {
  try {
    const crop = String(req.body.crop || '').trim().slice(0, 40);
    const market = String(req.body.market || '').trim().slice(0, 60);
    const price = Number(req.body.price);
    const trend = ['up', 'down', 'stable'].includes(req.body.trend) ? req.body.trend : 'stable';
    const unit = String(req.body.unit || 'per quintal').trim().slice(0, 30);
    if (!crop || !market) return res.status(400).json({ message: 'फसल और मंडी चुनें' });
    if (!Number.isFinite(price) || price <= 0 || price > 10_000_000) return res.status(400).json({ message: 'सही भाव (₹) डालें' });
    const rate = await MandiRate.create({
      crop, market, price: Math.round(price), unit, trend, date: new Date(),
      addedByName: displayName(req.editor), addedByVisitorId: req.editor._id,
    });
    res.status(201).json(rate);
    require('./farmer').notifyMandiRate(rate);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Notices ────────────────────────────────────────────────────
router.post('/notices', editorAuth, needRole('notice'), upload.single('image'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 120);
    const content = String(req.body.content || '').trim().slice(0, 3000);
    if (!title || !content) return res.status(400).json({ message: 'शीर्षक और सूचना दोनों लिखें' });
    const notice = new Notice({
      title, content,
      category: NOTICE_CATEGORIES.includes(req.body.category) ? req.body.category : 'general',
      postedBy: displayName(req.editor),
      addedByVisitorId: req.editor._id,
    });
    if (req.file) { notice.image = req.file.path; notice.cloudinaryId = req.file.filename; }
    await notice.save();
    res.status(201).json(notice);
    require('../services/notificationService').broadcast({
      title: `📢 ${notice.title}`.slice(0, 100),
      body: notice.content.replace(/\s+/g, ' ').slice(0, 160),
      imageUrl: notice.image || '',
      type: 'notice', targetPage: 'notices', targetId: String(notice._id), source: 'auto',
    }).catch(err => console.error('[AppEditor] notice notify error:', err.message));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── An editor's own recent entries, and removing a mistake ─────
router.get('/mine', editorAuth, async (req, res) => {
  try {
    const [rates, notices] = await Promise.all([
      MandiRate.find({ addedByVisitorId: req.editor._id }).sort({ createdAt: -1 }).limit(20).lean(),
      Notice.find({ addedByVisitorId: req.editor._id }).sort({ createdAt: -1 }).limit(20).select('title category createdAt').lean(),
    ]);
    res.json({ rates, notices });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/mandi-rates/:id', editorAuth, async (req, res) => {
  const r = await MandiRate.findOneAndDelete({ _id: req.params.id, addedByVisitorId: req.editor._id }).catch(() => null);
  if (!r) return res.status(404).json({ message: 'यह एंट्री नहीं मिली' });
  res.json({ message: 'हटा दिया' });
});

router.delete('/notices/:id', editorAuth, async (req, res) => {
  const n = await Notice.findOneAndDelete({ _id: req.params.id, addedByVisitorId: req.editor._id }).catch(() => null);
  if (!n) return res.status(404).json({ message: 'यह एंट्री नहीं मिली' });
  res.json({ message: 'हटा दिया' });
});

// ── ADMIN: manage editors (main admin and sarpanch) ────────────
function canManage(req, res, next) {
  if (req.admin && ['admin', 'sarpanch'].includes(req.admin.role)) return next();
  res.status(403).json({ message: 'Only the admin or sarpanch can manage app editors' });
}
const adminView = v => ({
  _id: v._id, name: displayName(v), phone: v.registeredPhone || '', area: v.registeredArea || '',
  photo: v.registeredPhoto || '', roles: v.appRoles || [], grantedBy: v.editorGrantedBy || '', grantedAt: v.editorGrantedAt || null,
});
const ADMIN_FIELDS = 'registeredName visitorName registeredPhone registeredArea registeredPhoto appRoles editorGrantedBy editorGrantedAt';

router.get('/admin/roles', auth, canManage, (req, res) => res.json(APP_ROLES));

router.get('/admin/editors', auth, canManage, async (req, res) => {
  try {
    const list = await Visitor.find({ 'appRoles.0': { $exists: true } }).select(ADMIN_FIELDS).sort({ editorGrantedAt: -1 }).lean();
    res.json(list.map(adminView));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Registered app users matching a name or phone number.
router.get('/admin/search', auth, canManage, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 40);
    if (q.length < 2) return res.json([]);
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const list = await Visitor.find({ isRegistered: true, $or: [{ registeredName: rx }, { registeredPhone: rx }] })
      .select(ADMIN_FIELDS).limit(20).lean();
    res.json(list.map(adminView));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* PUT /admin/:id { roles: ['mandi','notice'], newCode?: true }
   Returns { editor, code? }. A code is returned only when one is created: first
   grant, or newCode. Removing all roles ends every editor session for that person. */
router.put('/admin/:id', auth, canManage, async (req, res) => {
  try {
    const roles = [...new Set((req.body.roles || []).filter(r => APP_ROLES[r]))];
    const v = await Visitor.findById(req.params.id).select(`${ADMIN_FIELDS} +editorCodeHash editorVersion isRegistered`);
    if (!v) return res.status(404).json({ message: 'User not found' });
    if (roles.length && !v.isRegistered) return res.status(400).json({ message: 'Only users with a completed profile can be editors' });

    let code;
    if (!roles.length) {
      v.appRoles = [];
      v.editorCodeHash = undefined;
      v.editorVersion = (v.editorVersion || 0) + 1;
    } else {
      v.appRoles = roles;
      if (!v.editorCodeHash || req.body.newCode) {
        code = newCode();
        v.editorCodeHash = hashCode(code);
        v.editorVersion = (v.editorVersion || 0) + 1;
      }
      v.editorGrantedBy = req.admin.email || '';
      v.editorGrantedAt = new Date();
    }
    await v.save();
    res.json({ editor: adminView(v), ...(code ? { code } : {}) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
