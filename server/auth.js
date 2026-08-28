'use strict';
const crypto = require('crypto');

// Validates Telegram Mini App initData exactly as specified by Telegram.
// Returns the user object when valid, else null.
function validateInitData(initData, botToken, maxAgeSec) {
  if (!initData || typeof initData !== 'string' || !botToken) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch (e) { return null; }
  const hash = params.get('hash');
  if (!hash) return null;
  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (k === 'hash') continue;
    pairs.push(k + '=' + v);
  }
  pairs.sort();
  const dcs = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secretKey).update(dcs).digest('hex');
  if (!safeEq(calc, hash)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || !Number.isFinite(authDate)) return null;
  const maxAge = maxAgeSec || 86400;
  if (Date.now() / 1000 - authDate > maxAge) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) { user = null; }
  return user && Number.isFinite(Number(user.id)) ? user : null;
}

function safeEq(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

module.exports = { validateInitData };
