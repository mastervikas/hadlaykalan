const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Visitor = require('../models/Visitor');
const AndroidDevice = require('../models/AndroidDevice');
const LocationHistory = require('../models/LocationHistory');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const { tryLinkByPhone, tryLinkByWeakSignals } = require('../helpers/ipLink');

async function recordLocationVisit(entityType, entityId, snapshot) {
  await LocationHistory.create({ entityType, entityId, ...snapshot });
  const cutoff = await LocationHistory.findOne({ entityType, entityId })
    .sort({ recordedAt: -1 }).skip(49).select('recordedAt');
  if (cutoff) {
    await LocationHistory.deleteMany({ entityType, entityId, recordedAt: { $lt: cutoff.recordedAt } });
  }
}

// ---- Helper: Parse User-Agent ----
function parseUserAgent(ua) {
  if (!ua) return { browser: 'Unknown', browserVersion: '', os: 'Unknown', osVersion: '', device: 'desktop' };
  
  let browser = 'Unknown', browserVersion = '', os = 'Unknown', osVersion = '', device = 'desktop';
  
  if (/Edg\/(\d+[\.\d]*)/.test(ua)) { browser = 'Edge'; browserVersion = RegExp.$1; }
  else if (/OPR\/(\d+[\.\d]*)/.test(ua)) { browser = 'Opera'; browserVersion = RegExp.$1; }
  else if (/Chrome\/(\d+[\.\d]*)/.test(ua)) { browser = 'Chrome'; browserVersion = RegExp.$1; }
  else if (/Safari\/(\d+[\.\d]*)/.test(ua) && !/Chrome/.test(ua)) { browser = 'Safari'; browserVersion = RegExp.$1; }
  else if (/Firefox\/(\d+[\.\d]*)/.test(ua)) { browser = 'Firefox'; browserVersion = RegExp.$1; }
  else if (/MSIE\s(\d+[\.\d]*)/.test(ua) || /Trident/.test(ua)) { browser = 'IE'; browserVersion = RegExp.$1 || '11'; }
  
  if (/Windows NT (\d+[\.\d]*)/.test(ua)) { os = 'Windows'; osVersion = RegExp.$1; }
  else if (/Mac OS X (\d+[_\.\d]*)/.test(ua)) { os = 'macOS'; osVersion = RegExp.$1.replace(/_/g, '.'); }
  else if (/Android (\d+[\.\d]*)/.test(ua)) { os = 'Android'; osVersion = RegExp.$1; }
  else if (/iPhone OS (\d+[_\.\d]*)/.test(ua) || /iPad/.test(ua)) { os = 'iOS'; osVersion = (RegExp.$1 || '').replace(/_/g, '.'); }
  else if (/Linux/.test(ua)) { os = 'Linux'; }
  
  if (/Mobile|Android.*Mobile|iPhone/.test(ua)) device = 'mobile';
  else if (/iPad|Android(?!.*Mobile)|Tablet/.test(ua)) device = 'tablet';
  
  return { browser, browserVersion, os, osVersion, device };
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

// POST - Track visitor (token-based, public)
router.post('/track', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
               || req.headers['x-real-ip'] 
               || req.connection?.remoteAddress 
               || req.ip 
               || 'unknown';
    
    const ua = req.headers['user-agent'] || '';
    const parsed = parseUserAgent(ua);
    
    const { screenWidth, screenHeight, language, timezone, referrer, platform, page, visitorToken } = req.body;
    
    console.log('🔍 /track endpoint called. visitorToken:', visitorToken ? 'present' : 'missing');
    
    let visitor = null;

    // 1. Try to find by token only (token is the persistent identity)
    if (visitorToken) {
      // Verify JWT token validity, then look up in DB
      try {
        console.log('Verifying existing JWT token...');
        jwt.verify(visitorToken, process.env.JWT_SECRET);
        visitor = await Visitor.findOne({ visitorToken });
        if (visitor) console.log('✓ Found existing visitor:', visitor.visitorName);
      } catch (jwtErr) {
        // Invalid/expired JWT — visitor is new
        console.log('Token verification failed or visitor not found');
        visitor = null;
      }
    } else {
      console.log('No token in request - will create new visitor');
    }

    if (visitor) {
      // Update existing visitor
      visitor.visitCount += 1;
      visitor.lastVisit = new Date();
      visitor.userAgent = ua;
      Object.assign(visitor, parsed);
      if (screenWidth) visitor.screenWidth = screenWidth;
      if (screenHeight) visitor.screenHeight = screenHeight;
      if (language) visitor.language = language;
      if (timezone) visitor.timezone = timezone;
      if (referrer) visitor.referrer = referrer;
      if (platform) visitor.platform = platform;
      if (page && !visitor.pages.includes(page)) visitor.pages.push(page);
      
      // Track IP address (add if not already present)
      if (ip && ip !== 'unknown' && !visitor.ipAddresses.includes(ip)) {
        visitor.ipAddresses.push(ip);
      }

      // ── Streak calculation ──────────────────────────────────
      const todayStr = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
      if (visitor.lastStreakDate !== todayStr) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        if (visitor.lastStreakDate === yesterdayStr) {
          visitor.currentStreak = (visitor.currentStreak || 1) + 1;
        } else {
          visitor.currentStreak = 1; // streak broken
        }
        if (visitor.currentStreak > (visitor.longestStreak || 1)) {
          visitor.longestStreak = visitor.currentStreak;
        }
        visitor.lastStreakDate = todayStr;
      }
      // ───────────────────────────────────────────────────────

      // Re-issue JWT if visitor had old-format token (migration)
      if (visitor.visitorToken && !visitor.visitorToken.startsWith('eyJ')) {
        const freshToken = jwt.sign(
          { visitorName: visitor.visitorName, visitorId: visitor._id.toString() },
          process.env.JWT_SECRET
        );
        visitor.visitorToken = freshToken;
      }

      await visitor.save();
      // Run link strategies fire-and-forget — strong signals first, weak signals only link on 2+ matches
      if (visitor.registeredPhone) tryLinkByPhone(visitor.registeredPhone, 'visitor', visitor._id).catch(() => {});
      tryLinkByWeakSignals(visitor._id, 'visitor').catch(() => {});

      const totalVisitors = await Visitor.countDocuments();
      return res.json({
        success: true,
        totalVisitors,
        visitorToken: visitor.visitorToken,
        visitorName: visitor.visitorName,
        visitCount: visitor.visitCount,
        currentStreak: visitor.currentStreak,
        longestStreak: visitor.longestStreak,
        needsRegistration: !visitor.isRegistered && visitor.visitCount >= 5,
        isRegistered: visitor.isRegistered
      });
    }

    // 3. Create a brand new visitor
    // Auto-generate sequential visitor name: user1, user2, ...
    try {
      console.log('Creating new visitor... JWT_SECRET available:', !!process.env.JWT_SECRET);
      
      const lastVisitor = await Visitor.findOne().sort({ createdAt: -1 }).select('visitorName');
      let nextUserNum = 1;
      if (lastVisitor?.visitorName) {
        const match = lastVisitor.visitorName.match(/user(\d+)/);
        if (match) nextUserNum = parseInt(match[1]) + 1;
      }

      const visitorName = `user${nextUserNum}`;
      console.log('Generating JWT for visitor:', visitorName);
      
      // Generate JWT token (no expiry — permanent visitor identity)
      const newToken = jwt.sign(
        { visitorName, userId: nextUserNum },
        process.env.JWT_SECRET
      );
      console.log('JWT token generated successfully:', newToken.substring(0, 50) + '...');
      
      const visitorData = {
        visitorToken: newToken,
        visitorName: visitorName,
        userAgent: ua,
        ipAddresses: ip && ip !== 'unknown' ? [ip] : [],
        ...parsed,
        screenWidth: screenWidth || null,
        screenHeight: screenHeight || null,
        language: language || '',
        timezone: timezone || '',
        referrer: referrer || '',
        platform: platform || '',
        pages: page ? [page] : [],
        currentStreak: 1,
        longestStreak: 1,
        lastStreakDate: new Date().toISOString().slice(0, 10)
      };

      // Geo lookup
      try {
        const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,regionName,isp`);
        if (geoRes.ok) {
          const geo = await geoRes.json();
          if (geo.status !== 'fail') {
            visitorData.country = geo.country || '';
            visitorData.city = geo.city || '';
            visitorData.region = geo.regionName || '';
            visitorData.isp = geo.isp || '';
          }
        }
      } catch (geoErr) {
        console.warn('Geo lookup failed:', geoErr.message);
      }

      console.log('Creating visitor in DB...');
      const newVisitor = await Visitor.create(visitorData);
      console.log('✓ Visitor created successfully:', newVisitor._id);
      // screenWidth/height/location not yet known on first visit — weak signals will run on next ping
      
      const totalVisitors = await Visitor.countDocuments();
      
      const response = { 
        success: true, 
        totalVisitors, 
        visitorToken: newToken,
        visitorName: newVisitor.visitorName,
        visitCount: 1,
        currentStreak: 1,
        longestStreak: 1,
        needsRegistration: false,
        isRegistered: false
      };
      console.log('Sending response:', response);
      res.json(response);
    } catch (createErr) {
      console.error('❌ Visitor creation error:', createErr.message);
      console.error('Full error:', createErr);
      res.status(500).json({ message: 'Failed to create visitor: ' + createErr.message });
    }
  } catch (err) {
    console.error('Visitor tracking error:', err);
    res.status(500).json({ message: err.message });
  }
});

// GET - Top 10 streak leaderboard (public)
router.get('/streaks', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    // Only streaks still alive (visited today or yesterday) — filter BEFORE sorting and
    // limiting. Filtering afterwards left the top-5 empty whenever the biggest stored
    // streaks were old ones, and gave ranks like "44" to the people who remained.
    const top = await Visitor.find({ currentStreak: { $gte: 1 }, lastStreakDate: { $in: [today, yesterdayStr] } })
      .sort({ currentStreak: -1, longestStreak: -1 })
      .limit(limit)
      .select('visitorName registeredName registeredPhoto currentStreak longestStreak lastStreakDate isRegistered');

    const leaderboard = top.map((v, i) => ({
      rank: i + 1,
      name: (v.isRegistered && v.registeredName) || v.visitorName,
      photo: v.registeredPhoto || null,
      currentStreak: v.currentStreak,
      longestStreak: v.longestStreak,
      isActive: true,
      isRegistered: v.isRegistered,
    }));

    res.json({ success: true, leaderboard });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST - Register visitor (after 5+ visits)
router.post('/register', upload.single('photo'), async (req, res) => {
  try {
    const { visitorToken, name, phone, profession, area } = req.body;
    if (!visitorToken || !name || !phone) {
      return res.status(400).json({ message: 'Token, name & phone required' });
    }
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) {
      return res.status(400).json({ message: 'सही मोबाइल नंबर डालें / Enter a valid mobile number' });
    }

    const visitor = await Visitor.findOne({ visitorToken });
    if (!visitor) return res.status(404).json({ message: 'Visitor not found' });

    // Numbers are taken on trust (no SMS provider). The server must never return a
    // "verification code" in the response: that only pretended to verify the number.
    visitor.registeredName = name.trim();
    visitor.registeredPhone = phone.trim();
    visitor.registeredProfession = (profession || '').trim();
    visitor.registeredArea = (area || '').trim();
    visitor.isRegistered = true;
    visitor.registeredAt = visitor.registeredAt || new Date();
    visitor.otpCode = null;
    visitor.otpExpiry = null;

    if (req.file) {
      visitor.registeredPhoto = req.file.path;
      visitor.registeredPhotoCloudinaryId = req.file.filename;
    }

    await visitor.save();
    res.json({ success: true, message: 'Registration complete', visitorName: visitor.registeredName, isRegistered: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST - Verify OTP and complete registration
router.post('/verify-otp', async (req, res) => {
  // Kept so older cached copies of the website don't break: /register now completes
  // registration itself, so this only reports the current state.
  try {
    const { visitorToken } = req.body;
    if (!visitorToken) return res.status(400).json({ message: 'Token required' });
    const visitor = await Visitor.findOne({ visitorToken });
    if (!visitor || !visitor.isRegistered) return res.status(400).json({ message: 'Please register first' });
    res.json({ success: true, message: 'Registration complete', visitorName: visitor.registeredName, isRegistered: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET - Total visitor count (public)
// Returns sum of all visitCounts for public display
router.get('/count', async (req, res) => {
  try {
    const totalVisitors = await Visitor.countDocuments();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayVisitors = await Visitor.countDocuments({ lastVisit: { $gte: todayStart } });
    const registeredCount = await Visitor.countDocuments({ isRegistered: true });
    
    // Sum total visitCount from all visitors
    const totalVisitCountAgg = await Visitor.aggregate([
      { $group: { _id: null, totalVisitCount: { $sum: '$visitCount' } } }
    ]);
    
    const totalVisitCount = totalVisitCountAgg.length > 0 ? totalVisitCountAgg[0].totalVisitCount : 0;
    
    res.json({ 
      totalVisitors,      // For backward compatibility (unique visitor records)
      todayVisitors, 
      registeredCount,
      totalVisitCount: totalVisitCount  // NEW: Sum of all visitCounts for public UI
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET - All visitors (admin)
router.get('/admin/all', auth, async (req, res) => {
  try {
    const visitors = await Visitor.find().sort({ lastVisit: -1 });
    res.json(visitors);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET - Visitor stats (admin)  
router.get('/admin/stats', auth, async (req, res) => {
  try {
    const total = await Visitor.countDocuments();
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = await Visitor.countDocuments({ lastVisit: { $gte: todayStart } });
    
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    const thisWeek = await Visitor.countDocuments({ lastVisit: { $gte: weekStart } });
    
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const thisMonth = await Visitor.countDocuments({ lastVisit: { $gte: monthStart } });

    const registered = await Visitor.countDocuments({ isRegistered: true });
    
    // Device breakdown
    const devices = await Visitor.aggregate([
      { $group: { _id: '$device', count: { $sum: 1 } } }
    ]);
    
    // Browser breakdown
    const browsers = await Visitor.aggregate([
      { $group: { _id: '$browser', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    
    // OS breakdown
    const osStats = await Visitor.aggregate([
      { $group: { _id: '$os', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Country breakdown
    const countries = await Visitor.aggregate([
      { $match: { country: { $ne: null, $ne: '' } } },
      { $group: { _id: '$country', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    
    // Recent 7 days visitor trend
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date();
      dayStart.setDate(dayStart.getDate() - i);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const count = await Visitor.countDocuments({ 
        lastVisit: { $gte: dayStart, $lt: dayEnd } 
      });
      last7Days.push({ 
        date: dayStart.toISOString().split('T')[0], 
        count 
      });
    }

    // Recent 30 days for monthly chart
    const last30Days = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = new Date();
      dayStart.setDate(dayStart.getDate() - i);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const count = await Visitor.countDocuments({ 
        lastVisit: { $gte: dayStart, $lt: dayEnd } 
      });
      last30Days.push({ 
        date: dayStart.toISOString().split('T')[0], 
        count 
      });
    }

    // Top visitors by visit count
    const topVisitors = await Visitor.find()
      .sort({ visitCount: -1 })
      .limit(10)
      .select('visitorName visitCount isRegistered registeredName lastVisit device');

    res.json({ total, today, thisWeek, thisMonth, registered, devices, browsers, osStats, countries, last7Days, last30Days, topVisitors });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH - Set a display nickname (from streak popup name prompt)
// GET - Fetch current visitor profile by token
router.get('/me', async (req, res) => {
  try {
    const visitorToken = req.headers['x-visitor-token'] || req.query.token;
    if (!visitorToken) return res.status(400).json({ message: 'Token required' });
    const visitor = await Visitor.findOne({ visitorToken })
      .select('visitorName registeredName registeredPhone registeredPhoto registeredProfession registeredArea visitCount firstVisit lastVisit currentStreak longestStreak isRegistered city region country');
    if (!visitor) return res.status(404).json({ message: 'Visitor not found' });
    res.json({
      success: true,
      name: visitor.registeredName || visitor.visitorName,
      phone: visitor.registeredPhone || '',
      photo: visitor.registeredPhoto || '',
      profession: visitor.registeredProfession || '',
      area: visitor.registeredArea || '',
      visitCount: visitor.visitCount,
      firstVisit: visitor.firstVisit,
      lastVisit: visitor.lastVisit,
      currentStreak: visitor.currentStreak,
      longestStreak: visitor.longestStreak,
      city: visitor.city || '',
      region: visitor.region || '',
      isRegistered: visitor.isRegistered
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET - Nearby visitors using saved visitor profile name and current location name
// ── Nearby ──────────────────────────────────────────────────────
// Nearest opted-in people first, within a radius, using the 2dsphere index.
// Privacy: no coordinates or map links leave the server, distances are rounded to
// 0.5 km, and only people who share their own location may see the list.
const NEARBY_FIELDS = 'visitorName registeredName registeredPhone registeredPhoto registeredProfession registeredArea locationName locationUpdatedAt currentStreak isRegistered linkedAndroidDeviceId latitude longitude';
const validCoords = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const roundKm = d => Math.max(0.5, Math.round(d * 2) / 2);
const kmLabel = d => (d < 1 ? '1 km से कम' : `${d % 1 ? d.toFixed(1) : d} km`);

// Older documents only have latitude/longitude; give them the GeoJSON point once.
let geoBackfill = null;
function ensureGeoBackfill() {
  if (!geoBackfill) {
    geoBackfill = Visitor.updateMany(
      { latitude: { $gte: -90, $lte: 90 }, longitude: { $gte: -180, $lte: 180 }, 'geo.coordinates': { $exists: false } },
      [{ $set: { geo: { type: 'Point', coordinates: ['$longitude', '$latitude'] } } }]
    ).catch(err => { console.error('[Nearby] geo backfill failed:', err.message); geoBackfill = null; });
  }
  return geoBackfill;
}

// Google Maps link to the person's area: coordinates rounded to 2 decimals (~1 km),
// enough to find the neighbourhood without pinpointing anyone's house.
function approxMapUrl(lat, lng) {
  if (!validCoords(lat, lng)) return '';
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(2)},${lng.toFixed(2)}`;
}

function nearbyEntry(v, distanceKm, override = {}) {
  const d = distanceKm == null ? null : roundKm(distanceKm);
  const lat = override.lat ?? v.latitude, lng = override.lng ?? v.longitude;
  return {
    name: (v.registeredName || v.visitorName || 'गाँव वाले').trim(),
    phone: v.registeredPhone || '',
    photo: v.registeredPhoto || '',
    profession: v.registeredProfession || '',
    area: v.registeredArea || '',                                   // mohalla from the profile
    locationName: override.locationName || v.locationName || '',    // place of the latest shared location
    mapUrl: approxMapUrl(lat, lng),
    currentStreak: v.currentStreak || 0,
    isRegistered: Boolean(v.isRegistered),
    distanceKm: d,
    distanceLabel: d == null ? '' : kmLabel(d),
    updatedAt: override.updatedAt || v.locationUpdatedAt || null,
  };
}

// GET /api/visitors/nearby?token=…&radius=50&limit=60
router.get('/nearby', async (req, res) => {
  try {
    const visitorToken = req.headers['x-visitor-token'] || req.query.token;
    if (!visitorToken) return res.status(400).json({ message: 'Token required' });

    const me = await Visitor.findOne({ visitorToken })
      .select('visitorName registeredName registeredPhone registeredPhoto registeredProfession registeredArea latitude longitude locationName locationUpdatedAt currentStreak nearbySharingEnabled city region country');
    if (!me) return res.status(404).json({ message: 'Visitor not found' });

    const myName = (me.registeredName || me.visitorName || '').trim();
    const myPhone = (me.registeredPhone || '').trim();
    const profileComplete = Boolean(myName && !/^user\d+$/i.test(myName) && myPhone);
    const currentVisitor = {
      name: myName, phone: myPhone, profileComplete,
      photo: me.registeredPhoto || '', profession: me.registeredProfession || '', area: me.registeredArea || '',
      locationName: me.locationName || '', locationUpdatedAt: me.locationUpdatedAt || null,
      sharing: Boolean(me.nearbySharingEnabled), currentStreak: me.currentStreak || 0,
    };
    // Reciprocity: the list is for people who share their own location too.
    if (!profileComplete) return res.status(403).json({ message: 'पहले नाम और मोबाइल नंबर जोड़ें', needsProfile: true, currentVisitor });
    if (!me.nearbySharingEnabled) return res.status(403).json({ message: 'आस-पास के लोग देखने के लिए अपनी लोकेशन साझा करें', needsSharing: true, currentVisitor });

    const radiusKm = Math.min(200, Math.max(1, Number(req.query.radius) || 50));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const cutoff = new Date(Date.now() - 60 * 24 * 3600e3); // ignore locations older than 60 days
    const hasCoords = validCoords(me.latitude, me.longitude);
    const baseQuery = { _id: { $ne: me._id }, nearbySharingEnabled: true, locationUpdatedAt: { $gte: cutoff } };

    let people = [];
    if (hasCoords) {
      await ensureGeoBackfill();
      const rows = await Visitor.aggregate([
        { $geoNear: {
          near: { type: 'Point', coordinates: [me.longitude, me.latitude] },
          key: 'geo', distanceField: 'distM', spherical: true, maxDistance: radiusKm * 1000, query: baseQuery,
        } },
        { $limit: limit },
      ]);
      // People also using the old Android app: their phone may have a fresher location.
      const devIds = rows.map(v => v.linkedAndroidDeviceId).filter(Boolean);
      const devs = devIds.length
        ? new Map((await AndroidDevice.find({ _id: { $in: devIds } }).select('latitude longitude locationName locationUpdatedAt').lean()).map(d => [String(d._id), d]))
        : new Map();
      people = rows.map(v => {
        const d = v.linkedAndroidDeviceId && devs.get(String(v.linkedAndroidDeviceId));
        if (d && validCoords(d.latitude, d.longitude) && new Date(d.locationUpdatedAt || 0) > new Date(v.locationUpdatedAt || 0)) {
          return nearbyEntry(v, haversineDistanceKm(me.latitude, me.longitude, d.latitude, d.longitude), { locationName: d.locationName, updatedAt: d.locationUpdatedAt, lat: d.latitude, lng: d.longitude });
        }
        return nearbyEntry(v, v.distM / 1000);
      });

      // Old-app-only users (no visitor profile): bounded box first, then exact distance.
      const dLat = radiusKm / 111, dLng = radiusKm / (111 * Math.max(0.2, Math.cos(me.latitude * Math.PI / 180)));
      const devices = await AndroidDevice.find({
        linkedVisitorId: null, nearbySharingEnabled: true, locationUpdatedAt: { $gte: cutoff },
        latitude: { $gte: me.latitude - dLat, $lte: me.latitude + dLat },
        longitude: { $gte: me.longitude - dLng, $lte: me.longitude + dLng },
      }).select('registeredPhone brand model city locationName latitude longitude locationUpdatedAt').limit(50).lean();
      for (const dev of devices) {
        const km = haversineDistanceKm(me.latitude, me.longitude, dev.latitude, dev.longitude);
        if (km > radiusKm) continue;
        const r = roundKm(km);
        people.push({
          name: dev.registeredPhone ? 'ऐप यूज़र' : (`${dev.brand || ''} ${dev.model || ''}`.trim() || 'ऐप यूज़र'),
          phone: dev.registeredPhone || '', photo: '', profession: '', area: dev.city || '',
          locationName: dev.locationName || dev.city || '', mapUrl: approxMapUrl(dev.latitude, dev.longitude),
          currentStreak: 0, isRegistered: false, isAppUser: true,
          distanceKm: r, distanceLabel: kmLabel(r), updatedAt: dev.locationUpdatedAt || null,
        });
      }
      people.sort((a, b) => a.distanceKm - b.distanceKm);
      people = people.slice(0, limit);

      recordLocationVisit('Visitor', me._id, {
        latitude: me.latitude, longitude: me.longitude, locationName: me.locationName || '',
        city: me.city || '', region: me.region || '', country: me.country || '',
      }).catch(console.error);
    } else {
      // No usable location yet: most recently active sharers, without distances.
      const rows = await Visitor.find(baseQuery).select(NEARBY_FIELDS).sort({ locationUpdatedAt: -1 }).limit(limit).lean();
      people = rows.map(v => nearbyEntry(v, null));
    }

    res.json({ success: true, canMeasureDistance: hasCoords, radiusKm, currentVisitor, nearbyVisitors: people });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET - Location history for the current visitor
router.get('/location-history', async (req, res) => {
  try {
    const visitorToken = req.headers['x-visitor-token'] || req.query.token;
    if (!visitorToken) return res.status(400).json({ message: 'Token required' });

    const visitor = await Visitor.findOne({ visitorToken }).select('_id');
    if (!visitor) return res.status(404).json({ message: 'Visitor not found' });

    const history = await LocationHistory.find({ entityType: 'Visitor', entityId: visitor._id })
      .sort({ recordedAt: -1 })
      .limit(50)
      .select('-entityType -entityId -__v');

    res.json({ history });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH - Update visitor profile (name, profession, area, phone)
router.patch('/profile', async (req, res) => {
  try {
    const { visitorToken, name, profession, area, phone } = req.body;
    if (!visitorToken) return res.status(400).json({ message: 'Token required' });
    const visitor = await Visitor.findOne({ visitorToken });
    if (!visitor) return res.status(404).json({ message: 'Visitor not found' });
    if (name && name.trim())       visitor.visitorName          = name.trim().slice(0, 30);
    if (profession !== undefined)  visitor.registeredProfession = profession.trim().slice(0, 50);
    if (area !== undefined)        visitor.registeredArea       = area.trim().slice(0, 50);
    if (phone !== undefined)       visitor.registeredPhone      = phone.trim().slice(0, 15);
    await visitor.save();
    res.json({ success: true, name: visitor.visitorName });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/nickname', async (req, res) => {
  try {
    const { visitorToken, nickname } = req.body;
    if (!visitorToken || !nickname || !nickname.trim()) {
      return res.status(400).json({ message: 'Token and nickname required' });
    }
    const clean = nickname.trim().slice(0, 30);
    const visitor = await Visitor.findOne({ visitorToken });
    if (!visitor) return res.status(404).json({ message: 'Visitor not found' });
    visitor.visitorName = clean;
    await visitor.save();
    res.json({ success: true, visitorName: clean });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT - Update GPS location for visitor
router.put('/update-location', async (req, res) => {
  try {
    const { visitorToken, latitude, longitude, locationName, accuracy, onlyIfSharing } = req.body;
    if (!visitorToken) return res.status(400).json({ message: 'Token required' });

    let visitor = null;
    try {
      jwt.verify(visitorToken, process.env.JWT_SECRET);
      visitor = await Visitor.findOne({ visitorToken });
    } catch (e) { /* invalid token */ }

    if (!visitor) return res.status(404).json({ message: 'Visitor not found' });

    // The Android app refreshes location silently on every open. That refresh
    // must never opt someone into Nearby — only the Nearby page itself does.
    if (onlyIfSharing && !visitor.nearbySharingEnabled) {
      return res.json({ success: true, skipped: true });
    }

    const lat = Number(latitude), lng = Number(longitude);
    if (!validCoords(lat, lng)) return res.status(400).json({ message: 'लोकेशन सही नहीं है' });
    visitor.latitude = lat;
    visitor.longitude = lng;
    visitor.geo = { type: 'Point', coordinates: [lng, lat] };
    // No fresh place name (lookup failed or skipped): keep the last one.
    visitor.locationName = String(locationName || visitor.locationName || '').slice(0, 120);
    visitor.locationAccuracy = Number.isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : null;
    visitor.locationUpdatedAt = new Date();
    visitor.locationDenied = false;
    visitor.nearbySharingEnabled = true;
    await visitor.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT - Mark GPS permission denied
router.put('/location-denied', async (req, res) => {
  try {
    const { visitorToken } = req.body;
    if (!visitorToken) return res.status(400).json({ message: 'Token required' });

    let visitor = null;
    try {
      jwt.verify(visitorToken, process.env.JWT_SECRET);
      visitor = await Visitor.findOne({ visitorToken });
    } catch (e) { /* invalid token */ }

    if (visitor) {
      visitor.locationDenied = true;
      visitor.nearbySharingEnabled = false;
      await visitor.save();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST - Track activity (clicks, page views, page switches, etc.)
router.post('/track-activity', async (req, res) => {
  try {
    const { visitorToken, events } = req.body;
    if (!visitorToken || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ message: 'Token and events required' });
    }

    let visitor = null;
    try {
      jwt.verify(visitorToken, process.env.JWT_SECRET);
      visitor = await Visitor.findOne({ visitorToken });
    } catch (e) { /* invalid token */ }

    if (!visitor) return res.status(404).json({ message: 'Visitor not found' });

    // Append activity events (cap log at 2000 entries per visitor)
    const allowed = ['page_view', 'click', 'page_switch', 'session_start', 'session_end', 'search', 'scroll', 'form_submit', 'external_link', 'other'];
    const sanitized = events.slice(0, 50).map(e => ({
      type: allowed.includes(e.type) ? e.type : 'other',
      page: (e.page || '').substring(0, 200),
      fromPage: (e.fromPage || '').substring(0, 200),
      element: (e.element || '').substring(0, 100),
      elementText: (e.elementText || '').substring(0, 80),
      elementId: (e.elementId || '').substring(0, 80),
      elementClass: (e.elementClass || '').substring(0, 100),
      value: (e.value || '').substring(0, 200),
      timeOnPage: typeof e.timeOnPage === 'number' ? e.timeOnPage : null,
      ts: e.ts ? new Date(e.ts) : new Date()
    }));

    // Update pages visited list
    sanitized.forEach(ev => {
      if ((ev.type === 'page_view' || ev.type === 'page_switch') && ev.page && !visitor.pages.includes(ev.page)) {
        visitor.pages.push(ev.page);
      }
    });

    // Accumulate total time
    const addedTime = sanitized.reduce((sum, e) => sum + (e.timeOnPage || 0), 0);
    visitor.totalTimeOnSite = (visitor.totalTimeOnSite || 0) + addedTime;

    // Keep last 2000 activity events
    visitor.activityLog = [...visitor.activityLog, ...sanitized].slice(-2000);
    await visitor.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET - Single visitor full profile (admin)
router.get('/admin/profile/:id', auth, async (req, res) => {
  try {
    const visitor = await Visitor.findById(req.params.id);
    if (!visitor) return res.status(404).json({ message: 'Not found' });
    res.json(visitor);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE - Delete a visitor record (admin)
router.delete('/:id', auth, async (req, res) => {
  try {
    await Visitor.findByIdAndDelete(req.params.id);
    res.json({ message: 'Visitor record deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
