/* GET /api/admin-overview — one call for the admin dashboard's "app at a glance":
   app users, active phones, editors, live matches, notifications and what app
   editors posted recently. Counts only; no tokens or phone numbers leave here. */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Visitor = require('../models/Visitor');
const AndroidDevice = require('../models/AndroidDevice');
const AppNotification = require('../models/AppNotification');
const CricketMatch = require('../models/CricketMatch');
const Notice = require('../models/Notice');
const { MandiRate } = require('../models/Farmer');

router.get('/', auth, async (req, res) => {
  try {
    const now = Date.now();
    const day = new Date(now - 24 * 3600e3);
    const week = new Date(now - 7 * 24 * 3600e3);
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);

    const [registered, newThisWeek, pushPhones, activePhones, editors, liveMatches, matchesWeek,
      notifWeek, notifSent, mandiToday, editorRates, editorNotices] = await Promise.all([
      Visitor.countDocuments({ isRegistered: true }),
      Visitor.countDocuments({ isRegistered: true, registeredAt: { $gte: week } }),
      AndroidDevice.countDocuments({ fcmToken: { $ne: null }, notificationsEnabled: { $ne: false } }),
      AndroidDevice.countDocuments({ lastSeen: { $gte: day } }),
      Visitor.countDocuments({ 'appRoles.0': { $exists: true } }),
      CricketMatch.find({ status: { $in: ['live', 'innings_break'] } }).select('title teamA teamB innings currentInnings status').lean(),
      CricketMatch.countDocuments({ createdAt: { $gte: week } }),
      AppNotification.countDocuments({ audience: 'all', createdAt: { $gte: week } }),
      AppNotification.aggregate([{ $match: { createdAt: { $gte: week } } }, { $group: { _id: null, sent: { $sum: '$sentCount' } } }]),
      MandiRate.countDocuments({ createdAt: { $gte: startOfToday } }),
      MandiRate.find({ addedByVisitorId: { $ne: null } }).sort({ createdAt: -1 }).limit(6).select('crop price market addedByName createdAt').lean(),
      Notice.find({ addedByVisitorId: { $ne: null } }).sort({ createdAt: -1 }).limit(6).select('title postedBy category createdAt').lean(),
    ]);

    const recentEditorPosts = [
      ...editorRates.map(r => ({ kind: 'mandi', title: `${r.crop} ₹${r.price}`, sub: r.market, by: r.addedByName || '', at: r.createdAt })),
      ...editorNotices.map(n => ({ kind: 'notice', title: n.title, sub: n.category, by: n.postedBy || '', at: n.createdAt })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 8);

    res.json({
      appUsers: { registered, newThisWeek },
      phones: { withPush: pushPhones, activeToday: activePhones },
      editors,
      cricket: {
        live: liveMatches.map(m => {
          const inn = (m.innings || [])[(m.currentInnings || 1) - 1] || {};
          return { _id: m._id, title: m.title, teamA: m.teamA, teamB: m.teamB, status: m.status,
            score: inn.battingTeam ? `${inn.battingTeam} ${inn.runs || 0}/${inn.wickets || 0} (${inn.overs || 0}${inn.balls ? '.' + inn.balls : ''})` : '' };
        }),
        matchesThisWeek: matchesWeek,
      },
      notifications: { thisWeek: notifWeek, deliveredThisWeek: (notifSent[0] && notifSent[0].sent) || 0 },
      mandiToday,
      recentEditorPosts,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
