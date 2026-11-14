// The one JWT secret for the whole server. There is deliberately no fallback:
// a default secret in source code would let anyone mint valid tokens.
const secret = process.env.JWT_SECRET;
if (!secret) {
  throw new Error('JWT_SECRET is not set. Add it to the environment (Render → Environment) before starting the server.');
}
module.exports = secret;
