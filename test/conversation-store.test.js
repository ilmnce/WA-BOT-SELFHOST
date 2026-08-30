'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConversationStore, inferProject } = require('../src/conversation-store');

test('keeps messages isolated per WhatsApp number and reloads them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ariel-store-'));
  const file = path.join(directory, 'conversations.json');
  const store = new ConversationStore(file);

  store.addIncoming('628111@c.us', 'Minat PK18', { contactName: 'Andi' });
  store.addIncoming('628222@c.us', 'Mau rumah di Serang', { contactName: 'Sari' });
  store.addOutgoing('628111@c.us', 'Siap, ini brosurnya', { triggers: ['PL_PK18'] });
  store.flush();

  const reloaded = new ConversationStore(file);
  assert.equal(reloaded.get('628111@c.us').messages.length, 2);
  assert.equal(reloaded.get('628222@c.us').messages.length, 1);
  assert.equal(reloaded.get('628111@c.us').project, 'PK18');
});

test('supports unread state, lead status, and per-contact bot pause', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ariel-store-'));
  const store = new ConversationStore(path.join(directory, 'conversations.json'));
  store.addIncoming('628333@c.us', 'Halo');

  assert.equal(store.get('628333@c.us').unread, 1);
  assert.equal(store.markRead('628333@c.us').unread, 0);
  assert.equal(store.setBotPaused('628333@c.us', true).botPaused, true);
  assert.equal(store.setLeadStatus('628333@c.us', 'qualified').leadStatus, 'qualified');
});

test('infers project codes from messages and media triggers', () => {
  assert.equal(inferProject('Saya minat Pesona Kahuripan 17'), 'PK17');
  assert.equal(inferProject('', ['VIDEO_PK16']), 'PK16');
  assert.equal(inferProject('Halo'), null);
});
