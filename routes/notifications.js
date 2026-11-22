const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const AppNotification = require('../models/AppNotification');
const Notice = require('../models/Notice');
const Post = require('../models/Post');
const auth = require('../middleware/auth');
const { TARGET_PAGES, broadcast } = require('../services/notificationService');

// Broadcasting reaches every app install, so only the main admin and the sarpanch may do it.
function canBroadcast(req, res, next) {
  if (req.admin && ['admin', 'sarpanch'].includes(req.admin.role)) return next();
  return res.status(403).json({ message: 'Only the admin or sarpanch can send notifications' });
}

const PUBLIC_FIELDS = 'title body imageUrl type targetPage targetId clickUrl createdAt';
const NOTICE_CATEGORIES = ['event', 'meeting', 'announcement', 'emergency', 'general'];

// ── PUBLIC: in-app notification history (bell icon) ──────────
// GET /api/notifications?limit=30&before=<ISO date>
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 30));
    const filter = { audience: 'all' };
    const before = req.query.before ? new Date(req.query.before) : null;
    if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };

    const notifications = await AppNotification.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select(PUBLIC_FIELDS)
      .lean();
    res.json({ notifications, hasMore: notifications.length === limit });
  } catch (err) {
    console.error('Notification history error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── ADMIN: full log, including single-device pushes ──────────
// GET /api/notifications/admin/all?page=1
router.get('/admin/all', auth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const [notifications, total] = await Promise.all([
      AppNotification.find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('deviceId', 'brand model adminLabel')
        .lean(),
      AppNotification.countDocuments(),
    ]);
    res.json({ notifications, total, page, pages: Math.ceil(total / limit), targetPages: TARGET_PAGES });
  } catch (err) {
    console.error('Notification admin list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── PUBLIC: one notification (opened from a push when it is not in the loaded page) ──
// GET /api/notifications/:id
// GET/PUT /api/notifications/settings — admin on/off switches for automatic pushes.
// (Declared before '/:id' so "settings" is not read as a notification id.)
router.get('/settings', auth, canBroadcast, async (req, res) => {
  try {
    const { CATEGORIES, getSettings } = require('../services/notificationSettings');
    res.json({ categories: CATEGORIES, settings: await getSettings() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/settings', auth, canBroadcast, async (req, res) => {
  try {
    const { CATEGORIES, setSettings } = require('../services/notificationSettings');
    const settings = await setSettings(req.body.settings || {}, req.admin.email || '');
    res.json({ categories: CATEGORIES, settings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Not found' });
    const notification = await AppNotification.findOne({ _id: req.params.id, audience: 'all' })
      .select(PUBLIC_FIELDS).lean();
    if (!notification) return res.status(404).json({ message: 'Not found' });
    res.json(notification);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── ADMIN: send to all app users ─────────────────────────────
// POST /api/notifications/send
// { title, body, imageUrl?, targetPage?, targetId?, publishAs?: 'notice'|'post', noticeCategory? }
// publishAs also creates the content on that page so the tap lands on it.
router.post('/send', auth, canBroadcast, async (req, res) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 100);
    const body  = String(req.body.body  || '').trim().slice(0, 500);
    const imageUrl = String(req.body.imageUrl || '').trim();
    let targetPage = String(req.body.targetPage || '').trim();
    let targetId   = String(req.body.targetId   || '').trim();
    const publishAs = req.body.publishAs;

    if (!title || !body) return res.status(400).json({ message: 'title and body required' });
    if (targetPage && !TARGET_PAGES.includes(targetPage)) {
      return res.status(400).json({ message: 'Unknown target page' });
    }
    if (publishAs && !['notice', 'post'].includes(publishAs)) {
      return res.status(400).json({ message: 'publishAs must be notice or post' });
    }

    let published = null;
    if (publishAs === 'notice') {
      const category = NOTICE_CATEGORIES.includes(req.body.noticeCategory) ? req.body.noticeCategory : 'announcement';
      published = await Notice.create({
        title, content: body, category,
        postedBy: req.admin.role === 'sarpanch' ? 'Sarpanch' : 'Gram Panchayat',
        ...(imageUrl ? { image: imageUrl } : {}),
      });
      targetPage = 'notices';
      targetId = String(published._id);
    } else if (publishAs === 'post') {
      published = await Post.create({
        name: 'ग्राम पंचायत', title, content: body, topic: 'announcement', isApproved: true,
        ...(imageUrl ? { postImage: imageUrl } : {}),
      });
      targetPage = 'posts';
      targetId = String(published._id);
    }

    const type = { notices: 'notice', posts: 'post', schemes: 'scheme', farmer: 'farmer', weather: 'weather' }[targetPage] || 'general';
    const result = await broadcast({
      title, body, imageUrl, type, targetPage, targetId,
      source: 'admin', sentBy: req.admin.email || '',
    });

    res.json({
      success: true,
      notification: result.notification,
      sent: result.sent,
      failed: result.failed,
      published: published ? { type: publishAs, id: published._id } : null,
      pushError: result.pushError ? result.pushError.message : null,
    });
  } catch (err) {
    console.error('Notification send error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ── ADMIN: remove from history (does not recall the push) ────
// DELETE /api/notifications/:id
router.delete('/:id', auth, canBroadcast, async (req, res) => {
  try {
    await AppNotification.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
