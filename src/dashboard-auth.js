'use strict';

const crypto = require('crypto');

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBasicPassword(header = '') {
  if (!header.startsWith('Basic ')) return '';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0 ? decoded.slice(separator + 1) : '';
  } catch (_) {
    return '';
  }
}

function isAuthorized(headers, token) {
  if (!token) return true;
  return safeEqual(readBasicPassword(headers.authorization), token);
}

function createDashboardAuth(token) {
  return (req, res, next) => {
    if (isAuthorized(req.headers, token)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Ariel Dashboard"');
    return res.status(401).send('Akses dashboard memerlukan kata sandi.');
  };
}

module.exports = { createDashboardAuth, isAuthorized };
