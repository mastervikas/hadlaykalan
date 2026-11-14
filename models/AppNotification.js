const mongoose = require('mongoose');

// One row per push that went out. Broadcasts form the public in-app history
// (the bell icon); single-device pushes are kept for the admin log only.
const appNotificationSchema = new mongoose.Schema({
  title:    { type: String, required: true, trim: true, maxlength: 100 },
  body:     { type: String, required: true, trim: true, maxlength: 500 },
  imageUrl: { type: String, default: '' },

  // Where a tap lands: a page of the main site plus an optional item on it.
  type:       { type: String, default: 'general' },  // general | post | notice | weather | farmer | scheme | ...
  targetPage: { type: String, default: '' },          // '' = open the notification itself
  targetId:   { type: String, default: '' },
  clickUrl:   { type: String, default: '' },

  audience: { type: String, enum: ['all', 'device'], default: 'all' },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'AndroidDevice' },

  source:     { type: String, enum: ['admin', 'auto'], default: 'admin' },
  sentBy:     { type: String, default: '' },
  sentCount:  { type: Number, default: 0 },
  failedCount:{ type: Number, default: 0 },
}, { timestamps: true });

appNotificationSchema.index({ audience: 1, createdAt: -1 });

module.exports = mongoose.models.AppNotification || mongoose.model('AppNotification', appNotificationSchema);
