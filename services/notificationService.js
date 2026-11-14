/* ============================================
   APP NOTIFICATIONS

   Every push the server sends goes through here so it is also written to
   AppNotification — that collection is the in-app notification history
   behind the bell icon on the site.

   A tap opens   https://hadlaykalan.com/#/<page>?id=<item>&nid=<notification>
   The site's hash router reads `id` to open the exact item and `nid` to mark
   the notification as read. Hash URLs are used because the site is a static
   SPA: a path like /posts is not routed on every host.
   ============================================ */

const AppNotification = require('../models/AppNotification');
const AndroidDevice = require('../models/AndroidDevice');
const { categoryOf, isEnabled } = require('./notificationSettings');

// Pages a notification may open. Must match validPages in Frontend/shared/js/app.js.
const TARGET_PAGES = [
  'home', 'notices', 'contacts', 'posts', 'farmer', 'contest', 'worker', 'market',
  'weather', 'streaks', 'schemes', 'nearby', 'cricket', 'notifications',
];

// Lazy: androidDevices.js owns the Firebase Admin instance.
function getFcmHelper() {
  return require('../routes/androidDevices');
}

function buildClickUrl({ targetPage, targetId, notificationId }) {
  const known = TARGET_PAGES.includes(targetPage);
  const page = known ? targetPage : 'notifications';
  const params = new URLSearchParams();
  if (known && targetId) params.set('id', targetId);
  if (notificationId) params.set('nid', String(notificationId));
  const qs = params.toString();
  return `/#/${page}${qs ? '?' + qs : ''}`;
}

function cleanTarget(targetPage, targetId) {
  const page = TARGET_PAGES.includes(targetPage) ? targetPage : '';
  return { targetPage: page, targetId: page && targetId ? String(targetId).slice(0, 64) : '' };
}

// Devices that turned a category off in the app's notification settings are skipped.
async function getBroadcastTokens(category = null) {
  const filter = { fcmToken: { $exists: true, $ne: null }, notificationsEnabled: { $ne: false } };
  if (category) filter[`notifyPrefs.${category}`] = { $ne: false };
  const devices = await AndroidDevice.find(filter, 'fcmToken').lean();
  return [...new Set(devices.map(d => d.fcmToken).filter(Boolean))];
}

/**
 * Push without writing history — used for the live cricket scorecard, which
 * updates one notification in place (same `tag`) on a silent channel.
 */
async function pushOnly({ title, body, category, data = {}, tag, channelId = 'hadlay_live' }) {
  if (!(await isEnabled(category))) return { success: 0, failure: 0, skipped: true };
  const tokens = await getBroadcastTokens(category);
  if (!tokens.length) return { success: 0, failure: 0 };
  return getFcmHelper().sendFcmMulticast(tokens, title, body, data, null, { tag, channelId });
}

/**
 * Records a notification and pushes it to every registered app install.
 * The history row is kept even when the push itself fails, so app users still
 * see it under the bell. `pushError` carries the failure for the caller.
 */
async function broadcast({ title, body, imageUrl = '', type = 'general', targetPage = '', targetId = '', source = 'admin', sentBy = '', extraData = {}, category, tag }) {
  // Automatic pushes obey the admin's on/off switch for their category.
  const cat = category !== undefined ? category : categoryOf(type);
  if (source === 'auto' && !(await isEnabled(cat))) {
    return { notification: null, sent: 0, failed: 0, pushError: null, skipped: true };
  }
  const target = cleanTarget(targetPage, targetId);
  const notification = await AppNotification.create({
    title, body, imageUrl: imageUrl || '', type, ...target, audience: 'all', source, sentBy,
  });
  notification.clickUrl = buildClickUrl({ ...target, notificationId: notification._id });

  let result = { success: 0, failure: 0 };
  let pushError = null;
  try {
    // Admin messages reach everyone; automatic ones respect each device's choices.
    const tokens = await getBroadcastTokens(source === 'auto' ? cat : null);
    if (tokens.length) {
      result = await getFcmHelper().sendFcmMulticast(
        tokens, title, body,
        { ...extraData, type, targetPage: target.targetPage, targetId: target.targetId, clickUrl: notification.clickUrl, notificationId: notification._id },
        imageUrl || null,
        tag ? { tag } : {}
      );
    }
  } catch (err) {
    pushError = err;
    console.error('[Notifications] Broadcast push failed:', err.message);
  }

  notification.sentCount = result.success;
  notification.failedCount = result.failure;
  await notification.save();
  return { notification, sent: result.success, failed: result.failure, pushError };
}

/** Pushes to one device and logs it (admin-only history, not shown in the public feed). */
async function sendToDevice(device, { title, body, imageUrl = '', type = 'general', targetPage = '', targetId = '', sentBy = '', extraData = {} }) {
  const target = cleanTarget(targetPage, targetId);
  const notification = new AppNotification({
    title, body, imageUrl: imageUrl || '', type, ...target,
    audience: 'device', deviceId: device._id, source: 'admin', sentBy,
  });
  notification.clickUrl = buildClickUrl({ ...target, notificationId: notification._id });

  try {
    const messageId = await getFcmHelper().sendFcmToToken(
      device.fcmToken, title, body,
      { ...extraData, type, clickUrl: notification.clickUrl, notificationId: notification._id },
      imageUrl || null
    );
    notification.sentCount = 1;
    await notification.save();
    return { notification, messageId };
  } catch (err) {
    notification.failedCount = 1;
    await notification.save();
    throw err;
  }
}

module.exports = { TARGET_PAGES, broadcast, sendToDevice, pushOnly };
