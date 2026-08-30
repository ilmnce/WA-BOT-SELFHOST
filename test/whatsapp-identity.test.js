'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatIndonesianPhone, normalizePhoneId, resolveWhatsAppIdentity } = require('../src/whatsapp-identity');

test('formats Indonesian international numbers with a local 08 prefix', () => {
  assert.equal(formatIndonesianPhone('6282320753937'), '082320753937');
  assert.equal(formatIndonesianPhone('082320753937'), '082320753937');
});

test('normalizes WhatsApp phone IDs', () => {
  assert.equal(normalizePhoneId('6282320753937@c.us'), '6282320753937@c.us');
  assert.equal(normalizePhoneId('+62 823-2075-3937'), '6282320753937@c.us');
});

test('resolves a WhatsApp LID to its real phone number', async () => {
  const client = {
    getContactLidAndPhone: async () => [{ lid: '41369141817351@lid', pn: '6282320753937@c.us' }]
  };
  const identity = await resolveWhatsAppIdentity(client, '41369141817351@lid');
  assert.equal(identity.id, '6282320753937@c.us');
  assert.equal(identity.phone, '6282320753937');
  assert.equal(identity.displayPhone, '082320753937');
  assert.equal(identity.whatsappId, '41369141817351@lid');
});

test('uses a normal c.us number directly without an extra WhatsApp lookup', async () => {
  const client = { getContactLidAndPhone: async () => { throw new Error('should not run'); } };
  const identity = await resolveWhatsAppIdentity(client, '6282320753937@c.us');
  assert.equal(identity.id, '6282320753937@c.us');
  assert.equal(identity.displayPhone, '082320753937');
});

test('keeps the LID as a safe fallback when WhatsApp cannot map it', async () => {
  const client = { getContactLidAndPhone: async () => { throw new Error('not ready'); } };
  const identity = await resolveWhatsAppIdentity(client, '41369141817351@lid');
  assert.equal(identity.id, '41369141817351@lid');
  assert.equal(identity.displayPhone, null);
  assert.equal(identity.isResolved, false);
});
