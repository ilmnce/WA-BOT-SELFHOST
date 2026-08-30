'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, isWithinOperatingHours } = require('../src/config');
const { isAuthorized } = require('../src/dashboard-auth');

test('uses safe local defaults', () => {
  const config = loadConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.operatingTimeZone, 'Asia/Jakarta');
  assert.equal(config.filterSavedContacts, true);
});

test('requires a dashboard token for network exposure', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /DASHBOARD_TOKEN/);
  assert.doesNotThrow(() => loadConfig({ HOST: '0.0.0.0', DASHBOARD_TOKEN: 'rahasia' }));
});

test('supports normal and overnight operating windows', () => {
  const daytime = loadConfig({ OPERATING_TIMEZONE: 'UTC', OPERATING_START_HOUR: '8', OPERATING_END_HOUR: '17' });
  assert.equal(isWithinOperatingHours(new Date('2026-01-01T09:00:00Z'), daytime), true);
  assert.equal(isWithinOperatingHours(new Date('2026-01-01T18:00:00Z'), daytime), false);

  const overnight = loadConfig({ OPERATING_TIMEZONE: 'UTC', OPERATING_START_HOUR: '20', OPERATING_END_HOUR: '6' });
  assert.equal(isWithinOperatingHours(new Date('2026-01-01T23:00:00Z'), overnight), true);
  assert.equal(isWithinOperatingHours(new Date('2026-01-01T12:00:00Z'), overnight), false);
});

test('validates dashboard basic authentication', () => {
  const authorization = `Basic ${Buffer.from('admin:rahasia').toString('base64')}`;
  assert.equal(isAuthorized({ authorization }, 'rahasia'), true);
  assert.equal(isAuthorized({ authorization }, 'salah'), false);
});
