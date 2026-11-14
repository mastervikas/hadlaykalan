/* Which automatic pushes are switched on (admin-controlled) and the category list
   shared by the server, the admin panel and the app's notification settings. */
const NotificationSetting = require('../models/NotificationSetting');

// key → Hindi label. `type` values passed to broadcast() map onto these.
const CATEGORIES = {
  cricket: 'क्रिकेट (मैच शुरू / नतीजा)',
  cricketLive: 'क्रिकेट लाइव स्कोर',
  farmer: 'मंडी भाव',
  notice: 'सूचनाएं',
  post: 'नई पोस्ट',
  market: 'बाज़ार',
  worker: 'मज़दूर / काम',
  contest: 'प्रतियोगिता',
  weather: 'मौसम',
};
const DEFAULTS = Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, true]));

const categoryOf = type => (CATEGORIES[type] ? type : null);

let cache = null;
let cachedAt = 0;

async function getSettings() {
  if (cache && Date.now() - cachedAt < 60_000) return cache;
  const row = await NotificationSetting.findOne({ key: 'global' }).lean().catch(() => null);
  cache = { ...DEFAULTS, ...((row && row.categories) || {}) };
  cachedAt = Date.now();
  return cache;
}

async function setSettings(categories, updatedBy = '') {
  const clean = {};
  for (const k of Object.keys(CATEGORIES)) if (typeof categories[k] === 'boolean') clean[k] = categories[k];
  const current = await getSettings();
  const next = { ...current, ...clean };
  await NotificationSetting.findOneAndUpdate({ key: 'global' }, { categories: next, updatedBy }, { upsert: true });
  cache = next; cachedAt = Date.now();
  return next;
}

async function isEnabled(category) {
  if (!category) return true;
  return (await getSettings())[category] !== false;
}

module.exports = { CATEGORIES, DEFAULTS, categoryOf, getSettings, setSettings, isEnabled };
