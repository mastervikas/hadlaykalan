const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');

/* Checks the fields a site visitor may set. Their contact is published with no
   review, so keep it to a phone-number shape and bounded text lengths. */
function readUserContactFields(body) {
  const name = String(body.name || '').trim().slice(0, 60);
  const phone = String(body.phone || '').trim();
  const digits = phone.replace(/\D/g, '');
  if (!name) return { error: 'नाम ज़रूरी है / Name is required' };
  // Reject rather than strip: stripping junk can quietly turn it into someone else's number.
  if (!/^[\d+\-\s()]{10,20}$/.test(phone) || digits.length < 10 || digits.length > 13) {
    return { error: 'सही फ़ोन नंबर डालें / Enter a valid phone number' };
  }
  return {
    fields: {
      name,
      phone,
      role: String(body.role || 'other').trim().slice(0, 40) || 'other',
      areaLocation: String(body.areaLocation || '').trim().slice(0, 60),
      address: String(body.address || '').trim().slice(0, 120),
      description: String(body.description || '').trim().slice(0, 300),
    },
  };
}

// Get all approved contacts
router.get('/', async (req, res) => {
  try {
    const { role, area, search } = req.query;
    const filter = { isApproved: true };
    if (role && role !== 'all') filter.role = role;
    if (area && area !== 'all') filter.areaLocation = area;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }
    const contacts = await Contact.find(filter).sort({ isImportant: -1, name: 1 });
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all contacts (admin)
router.get('/admin/all', auth, async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ isApproved: 1, createdAt: -1 });
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Submit contact (public — published immediately; admin can hide or delete it later)
router.post('/submit', upload.single('image'), async (req, res) => {
  try {
    const { fields, error } = readUserContactFields(req.body);
    if (error) return res.status(400).json({ message: error });

    const editToken = crypto.randomBytes(32).toString('hex');
    const contactData = {
      ...fields,
      isApproved: true,
      addedByUser: true,
      visitorToken: String(req.body.visitorToken || '').slice(0, 500),
      editToken,
    };
    if (req.file) {
      contactData.image = req.file.path;
      contactData.cloudinaryId = req.file.filename;
    }
    const contact = await Contact.create(contactData);
    const result = contact.toObject();
    delete result.visitorToken;
    // Returned once; the browser stores it so this visitor can edit later.
    res.status(201).json({ contact: { ...result, editToken: undefined }, editToken });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Edit a contact the visitor added themselves (public, needs its editToken)
router.put('/:id/user-edit', upload.single('image'), async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id).select('+editToken');
    if (!contact || !contact.editToken) return res.status(404).json({ message: 'Contact not found' });
    const supplied = String(req.body.editToken || '');
    const valid = supplied.length === contact.editToken.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(contact.editToken));
    if (!valid) return res.status(403).json({ message: 'आप केवल अपना जोड़ा हुआ संपर्क बदल सकते हैं / You can only edit contacts you added' });

    const { fields, error } = readUserContactFields(req.body);
    if (error) return res.status(400).json({ message: error });
    Object.assign(contact, fields);

    if (req.file) {
      if (contact.cloudinaryId) {
        try { await cloudinary.uploader.destroy(contact.cloudinaryId); } catch (e) { /* old image already gone */ }
      }
      contact.image = req.file.path;
      contact.cloudinaryId = req.file.filename;
    }
    await contact.save();
    const result = contact.toObject();
    delete result.editToken;
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Create contact (admin - auto approved)
router.post('/', auth, upload.single('image'), async (req, res) => {
  try {
    const contactData = {
      name: req.body.name,
      phone: req.body.phone,
      role: req.body.role,
      areaLocation: req.body.areaLocation || '',
      address: req.body.address,
      description: req.body.description,
      isApproved: true,
      isImportant: req.body.isImportant === 'true'
    };
    if (req.file) {
      contactData.image = req.file.path;
      contactData.cloudinaryId = req.file.filename;
    }
    const contact = new Contact(contactData);
    await contact.save();
    res.status(201).json(contact);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Approve (show) or hide a contact — body { isApproved: false } hides it
router.put('/approve/:id', auth, async (req, res) => {
  try {
    const isApproved = req.body?.isApproved !== false;
    const contact = await Contact.findByIdAndUpdate(req.params.id, { isApproved }, { new: true });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update contact
router.put('/:id', auth, upload.single('image'), async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ message: 'Contact not found' });

    if (req.file) {
      if (contact.cloudinaryId) await cloudinary.uploader.destroy(contact.cloudinaryId);
      contact.image = req.file.path;
      contact.cloudinaryId = req.file.filename;
    }

    contact.name = req.body.name || contact.name;
    contact.phone = req.body.phone || contact.phone;
    contact.role = req.body.role || contact.role;
    contact.areaLocation = req.body.areaLocation !== undefined ? req.body.areaLocation : contact.areaLocation;
    contact.address = req.body.address || contact.address;
    contact.description = req.body.description || contact.description;
    contact.isImportant = req.body.isImportant !== undefined ? req.body.isImportant === 'true' : contact.isImportant;

    await contact.save();
    res.json(contact);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete contact
router.delete('/:id', auth, async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ message: 'Contact not found' });
    if (contact.cloudinaryId) await cloudinary.uploader.destroy(contact.cloudinaryId);
    await contact.deleteOne();
    res.json({ message: 'Contact deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
