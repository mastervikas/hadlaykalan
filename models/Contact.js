const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  role: { type: String, default: 'other', trim: true },
  areaLocation: { type: String, default: '', trim: true },
  address: { type: String },
  image: { type: String },
  cloudinaryId: { type: String },
  isApproved: { type: Boolean, default: false },
  isImportant: { type: Boolean, default: false },
  description: { type: String },
  // Contacts added from the site go live immediately. The creator's browser
  // keeps editToken and may edit the contact with it (same idea as posts).
  // select:false keeps it out of every query unless asked for explicitly.
  addedByUser: { type: Boolean, default: false },
  visitorToken: { type: String, select: false },
  editToken: { type: String, select: false }
}, { timestamps: true });

module.exports = mongoose.models.Contact || mongoose.model('Contact', contactSchema);
