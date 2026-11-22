const express = require('express');
const router = express.Router();
const AreaLocation = require('../models/AreaLocation');
const Role = require('../models/Role');
const AppConfig = require('../models/AppConfig');
const auth = require('../middleware/auth');

const { SECTION_DEFAULTS, sanitizeSections } = require('../helpers/homeSections');

// ── App Config keys with defaults ─────────────────────────────
// Built fresh per call: `sections` is a nested object and a shared reference
// would let one request's edit leak into the next request's defaults.
const appConfigDefaults = () => ({
  apkUrl:          '',
  bannerEnabled:   true,
  bannerTitle:     'हडलाय कलां ऐप',
  bannerSubtitle:  'नोटिफिकेशन पाएं • तेज़ अनुभव',
  homeCardTagline: 'Android ऐप डाउनलोड करें',
  sections:        SECTION_DEFAULTS(),
  // In-app update — read by HadlayKalanApp/AppUpdater.kt. Written only by
  // POST /app-update/release from a GitHub release, never typed by hand.
  githubRepo:               '',  // "owner/repo" whose releases carry the APK
  androidLatestVersionCode: 0,
  androidLatestVersionName: '',
  androidMinVersionCode:    0,   // below this the update cannot be skipped
  androidUpdateNotes:       '',
  androidUpdateApkUrl:      '',  // the exact release asset, not ".../latest/..."
  androidReleasedAt:        null,
  // Native (Expo) app — update popup that opens Google Play (Play policy forbids
  // apps installing their own APKs), and the list of backend URLs the app can fall
  // back to if one stops answering. Edited in the admin panel's App Config.
  nativeLatestVersion: '',   // e.g. "1.2.0": older apps see an "update available" popup
  nativeMinVersion:    '',   // older than this: the popup cannot be closed
  nativeUpdateMessage: '',
  nativeUpdateUrl:     'https://play.google.com/store/apps/details?id=com.hadlaykalan.com',
  apiUrls:             [],   // e.g. ["https://hadlaykalan.onrender.com", "https://api.hadlaykalan.com"]
});

// Set only through the release endpoint, so app users always get a matching
// version number + APK pair that came from GitHub.
const RELEASE_KEYS = ['androidLatestVersionCode', 'androidLatestVersionName', 'androidMinVersionCode',
  'androidUpdateNotes', 'androidUpdateApkUrl', 'androidReleasedAt'];

const APP_CONFIG_DEFAULTS = appConfigDefaults();

// GET /api/settings/app-config  — public, returns merged defaults + DB values
router.get('/app-config', async (req, res) => {
  try {
    const docs = await AppConfig.find();
    const result = appConfigDefaults();
    docs.forEach(d => { result[d.key] = d.value; });
    // Stored sections may predate a newly added key — merge so the frontend
    // always receives every section rather than `undefined` for a new one.
    result.sections = sanitizeSections(result.sections);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/settings/app-config/:key  — admin only, upsert one key
router.put('/app-config/:key', auth, async (req, res) => {
  try {
    const { key } = req.params;
    if (!Object.prototype.hasOwnProperty.call(APP_CONFIG_DEFAULTS, key)) {
      return res.status(400).json({ message: `Unknown config key: ${key}` });
    }
    // These steer every app install (where it connects, forced updates): main admin only.
    if (['apiUrls', 'nativeMinVersion', 'nativeUpdateUrl'].includes(key) && req.admin.role !== 'admin') {
      return res.status(403).json({ message: 'Only the main admin can change this setting' });
    }
    if (RELEASE_KEYS.includes(key)) {
      return res.status(400).json({ message: 'Use “Release to all users” to change the app version' });
    }
    let value = key === 'sections'
      ? sanitizeSections(req.body.value)
      : req.body.value;
    if (key === 'nativeLatestVersion' || key === 'nativeMinVersion') {
      value = String(value || '').trim();
      if (value && !/^\d+\.\d+\.\d+$/.test(value)) return res.status(400).json({ message: 'Version must look like 1.2.0' });
    }
    if (key === 'nativeUpdateUrl') {
      value = String(value || '').trim();
      if (value && !/^(https:\/\/|market:\/\/)/.test(value)) return res.status(400).json({ message: 'Update link must start with https:// or market://' });
    }
    if (key === 'apiUrls') {
      const list = (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/)).map(u => String(u).trim().replace(/\/+$/, '')).filter(Boolean);
      const bad = list.find(u => !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(u));
      if (bad) return res.status(400).json({ message: `Not a valid https URL: ${bad}` });
      value = [...new Set(list)].slice(0, 5);
    }
    if (key === 'githubRepo') {
      value = String(value || '').trim();
      if (value && !GITHUB_REPO.test(value)) return res.status(400).json({ message: 'GitHub repository must look like owner/repo' });
    }

    const doc = await AppConfig.findOneAndUpdate(
      { key },
      { value, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============ APP UPDATE (GitHub Releases) ============

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Must match the versionCode formula in HadlayKalanApp/app/build.gradle.
function versionCodeFromName(name) {
  const m = String(name || '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const [maj, min, pat] = m.slice(1).map(Number);
  if (min > 99 || pat > 99) return null;
  return maj * 10000 + min * 100 + pat;
}

async function getConfigValue(key) {
  const doc = await AppConfig.findOne({ key }).lean();
  return doc ? doc.value : APP_CONFIG_DEFAULTS[key];
}

async function setConfigValues(values) {
  const now = new Date();
  await Promise.all(Object.entries(values).map(([key, value]) =>
    AppConfig.findOneAndUpdate({ key }, { value, updatedAt: now }, { upsert: true })));
}

/* Reads the latest published release of the configured repo and picks its
   .apk asset. Throws an Error with a user-facing message on any problem. */
async function fetchLatestGithubRelease() {
  const repo = await getConfigValue('githubRepo');
  if (!repo || !GITHUB_REPO.test(repo)) throw new Error('Set the GitHub repository (owner/repo) first');

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hadlaykalan-admin' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) throw new Error(`No published release found in ${repo} (a private repo also shows this — app users could not download from it)`);
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
  const rel = await res.json();

  const apk = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
  if (!apk) throw new Error(`Release ${rel.tag_name} has no .apk file attached`);
  const versionCode = versionCodeFromName(rel.tag_name);
  if (!versionCode) throw new Error(`Release tag "${rel.tag_name}" must look like v1.0.6`);

  return {
    repo,
    tag: rel.tag_name,
    versionName: rel.tag_name.replace(/^v/, ''),
    versionCode,
    notes: String(rel.body || '').trim().slice(0, 600),
    apkUrl: apk.browser_download_url,
    apkName: apk.name,
    apkSize: apk.size,
    publishedAt: rel.published_at,
    htmlUrl: rel.html_url,
  };
}

async function currentRelease() {
  const docs = await AppConfig.find({ key: { $in: RELEASE_KEYS } }).lean();
  const out = {};
  RELEASE_KEYS.forEach(k => { out[k] = APP_CONFIG_DEFAULTS[k]; });
  docs.forEach(d => { out[d.key] = d.value; });
  return out;
}

// GET /api/settings/app-update/github — admin: what GitHub has vs what app users get
router.get('/app-update/github', auth, auth.requireAdmin, async (req, res) => {
  const current = await currentRelease();
  try {
    const latest = await fetchLatestGithubRelease();
    res.json({ latest, current, isNewer: latest.versionCode > (current.androidLatestVersionCode || 0) });
  } catch (err) {
    res.status(400).json({ message: err.message, current });
  }
});

// POST /api/settings/app-update/release — admin: push GitHub's latest release to every app
// Body { mandatory?: boolean }. Re-reads GitHub here rather than trusting the browser.
router.post('/app-update/release', auth, auth.requireAdmin, async (req, res) => {
  try {
    const latest = await fetchLatestGithubRelease();
    const current = await currentRelease();
    const mandatory = req.body?.mandatory === true;
    await setConfigValues({
      androidLatestVersionCode: latest.versionCode,
      androidLatestVersionName: latest.versionName,
      androidUpdateNotes: latest.notes,
      androidUpdateApkUrl: latest.apkUrl,
      androidReleasedAt: new Date(),
      // Mandatory raises the floor to this release; otherwise keep the old floor.
      androidMinVersionCode: mandatory ? latest.versionCode : (current.androidMinVersionCode || 0),
    });
    res.json({ success: true, released: latest, mandatory });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ============ AREA LOCATIONS ============

// GET all active areas (public)
router.get('/areas', async (req, res) => {
  try {
    const areas = await AreaLocation.find({ isActive: true }).sort({ name: 1 });
    res.json(areas);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET all areas (admin)
router.get('/areas/admin/all', auth, async (req, res) => {
  try {
    const areas = await AreaLocation.find().sort({ name: 1 });
    res.json(areas);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST create area (admin)
router.post('/areas', auth, async (req, res) => {
  try {
    const { name, nameHi } = req.body;
    if (!name) return res.status(400).json({ message: 'Area name is required' });
    const area = new AreaLocation({ name: name.trim(), nameHi: nameHi ? nameHi.trim() : '' });
    await area.save();
    res.status(201).json(area);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'Area already exists' });
    res.status(500).json({ message: err.message });
  }
});

// PUT update area (admin)
router.put('/areas/:id', auth, async (req, res) => {
  try {
    const { name, nameHi, isActive } = req.body;
    const area = await AreaLocation.findById(req.params.id);
    if (!area) return res.status(404).json({ message: 'Area not found' });
    if (name) area.name = name.trim();
    if (nameHi !== undefined) area.nameHi = nameHi.trim();
    if (isActive !== undefined) area.isActive = isActive;
    await area.save();
    res.json(area);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE area (admin)
router.delete('/areas/:id', auth, async (req, res) => {
  try {
    await AreaLocation.findByIdAndDelete(req.params.id);
    res.json({ message: 'Area deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============ ROLES ============

// GET all active roles (public)
router.get('/roles', async (req, res) => {
  try {
    const roles = await Role.find({ isActive: true }).sort({ label: 1 });
    res.json(roles);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET all roles (admin)
router.get('/roles/admin/all', auth, async (req, res) => {
  try {
    const roles = await Role.find().sort({ label: 1 });
    res.json(roles);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST create role (admin)
router.post('/roles', auth, async (req, res) => {
  try {
    const { name, label, labelHi, icon } = req.body;
    if (!name || !label) return res.status(400).json({ message: 'Name and label are required' });
    const role = new Role({
      name: name.trim().toLowerCase().replace(/\s+/g, '_'),
      label: label.trim(),
      labelHi: labelHi ? labelHi.trim() : '',
      icon: icon || 'fa-user'
    });
    await role.save();
    res.status(201).json(role);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'Role already exists' });
    res.status(500).json({ message: err.message });
  }
});

// PUT update role (admin)
router.put('/roles/:id', auth, async (req, res) => {
  try {
    const { name, label, labelHi, icon, isActive } = req.body;
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ message: 'Role not found' });
    if (name) role.name = name.trim().toLowerCase().replace(/\s+/g, '_');
    if (label) role.label = label.trim();
    if (labelHi !== undefined) role.labelHi = labelHi.trim();
    if (icon) role.icon = icon;
    if (isActive !== undefined) role.isActive = isActive;
    await role.save();
    res.json(role);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE role (admin)
router.delete('/roles/:id', auth, async (req, res) => {
  try {
    await Role.findByIdAndDelete(req.params.id);
    res.json({ message: 'Role deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
