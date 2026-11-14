const mongoose = require('mongoose');

const villageInfoSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.VillageInfo || mongoose.model('VillageInfo', villageInfoSchema);
