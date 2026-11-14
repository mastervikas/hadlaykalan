const mongoose = require('mongoose');

// Admin switches for automatic pushes, one row (key: 'global').
// Each category can be turned off; cricket also has a separate switch for the
// ball-by-ball live scorecard.
const notificationSettingSchema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },
  categories: { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.models.NotificationSetting || mongoose.model('NotificationSetting', notificationSettingSchema);
