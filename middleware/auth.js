const jwt = require('jsonwebtoken');
const JWT_SECRET = require('../helpers/jwtSecret');

// Visitor, worker and shop tokens are signed with the same secret, so a valid
// signature alone is not enough: only tokens issued by /api/auth/login carry an
// admin id, email and one of these roles.
const ADMIN_ROLES = ['admin', 'sarpanch', 'contest_admin', 'market_rate', 'subadmin'];

function readAdminToken(authHeader) {
  const token = String(authHeader || '').replace('Bearer ', '');
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || !decoded.id || !decoded.email || !ADMIN_ROLES.includes(decoded.role)) return null;
    return decoded;
  } catch {
    return null;
  }
}

module.exports = function(req, res, next) {
  if (!req.header('Authorization')) return res.status(401).json({ message: 'Access denied. No token provided.' });
  const decoded = readAdminToken(req.header('Authorization'));
  if (!decoded) return res.status(401).json({ message: 'Invalid token.' });
  req.admin = decoded; // { id, email, role, permissions }
  next();
};

module.exports.readAdminToken = readAdminToken;
module.exports.ADMIN_ROLES = ADMIN_ROLES;

// Only main admin can manage sub-admins
module.exports.requireAdmin = function(req, res, next) {
  if (req.admin && req.admin.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Only the main admin can perform this action' });
  }
};
