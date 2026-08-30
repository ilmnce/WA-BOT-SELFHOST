'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function parseInteger(value, fallback, { min, max } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  if (min !== undefined && parsed < min) return fallback;
  if (max !== undefined && parsed > max) return fallback;
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch (_) {
    return false;
  }
}

function loadConfig(env = process.env) {
  const host = (env.HOST || '127.0.0.1').trim();
  const dashboardToken = (env.DASHBOARD_TOKEN || '').trim();
  const timeZone = (env.OPERATING_TIMEZONE || 'Asia/Jakarta').trim();

  if (!LOOPBACK_HOSTS.has(host) && !dashboardToken) {
    throw new Error('DASHBOARD_TOKEN wajib diisi saat HOST dibuka ke jaringan.');
  }
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`OPERATING_TIMEZONE tidak valid: ${timeZone}`);
  }

  return Object.freeze({
    port: parseInteger(env.PORT, 3000, { min: 1, max: 65535 }),
    host,
    dashboardToken,
    operatingTimeZone: timeZone,
    operatingStartHour: parseInteger(env.OPERATING_START_HOUR, 8, { min: 0, max: 23 }),
    operatingEndHour: parseInteger(env.OPERATING_END_HOUR, 24, { min: 1, max: 24 }),
    debounceMs: parseInteger(env.MESSAGE_DEBOUNCE_MS, 6000, { min: 500, max: 60000 }),
    filterSavedContacts: parseBoolean(env.FILTER_SAVED_CONTACTS, true),
    botActiveAtStartup: parseBoolean(env.BOT_ACTIVE_AT_STARTUP, true),
    historyTtlMs: parseInteger(env.HISTORY_TTL_HOURS, 24, { min: 1, max: 720 }) * 3600000
  });
}

function getHourInTimeZone(date, timeZone) {
  const hour = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone
  }).formatToParts(date).find(part => part.type === 'hour')?.value;
  return Number.parseInt(hour, 10);
}

function isWithinOperatingHours(date, config) {
  const hour = getHourInTimeZone(date, config.operatingTimeZone);
  const start = config.operatingStartHour;
  const end = config.operatingEndHour;

  if (start === end || (start === 0 && end === 24)) return true;
  if (end === 24) return hour >= start;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

module.exports = { loadConfig, parseBoolean, parseInteger, isWithinOperatingHours };
