'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LEAD_STATUSES = new Set(['new', 'contacted', 'qualified', 'survey', 'booking', 'follow_up', 'closed']);

function inferProject(text = '', triggers = []) {
  const combined = `${text} ${Array.isArray(triggers) ? triggers.join(' ') : ''}`;
  const match = combined.match(/(?:PK\s*|PESONA\s+KAHURIPAN\s*)(1[4-8])/i);
  return match ? `PK${match[1]}` : null;
}

function cleanContact(raw = {}) {
  return {
    id: String(raw.id || raw.sender || ''),
    phone: String(raw.phone || raw.id || raw.sender || '').replace(/@.+$/, ''),
    contactName: raw.contactName ? String(raw.contactName) : null,
    isSaved: Boolean(raw.isSaved),
    project: raw.project || null,
    leadStatus: LEAD_STATUSES.has(raw.leadStatus) ? raw.leadStatus : 'new',
    botPaused: Boolean(raw.botPaused),
    unread: Number.isInteger(raw.unread) ? Math.max(0, raw.unread) : 0,
    lastMessage: raw.lastMessage ? String(raw.lastMessage) : '',
    lastMessageAt: raw.lastMessageAt || null,
    lastDirection: raw.lastDirection === 'out' ? 'out' : 'in',
    messages: Array.isArray(raw.messages) ? raw.messages : []
  };
}

class ConversationStore {
  constructor(filePath, { maxMessages = 300, saveDelayMs = 200 } = {}) {
    this.filePath = filePath;
    this.maxMessages = maxMessages;
    this.saveDelayMs = saveDelayMs;
    this.contacts = new Map();
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const rows = Array.isArray(parsed.contacts) ? parsed.contacts : [];
      for (const row of rows) {
        const contact = cleanContact(row);
        if (contact.id) this.contacts.set(contact.id, contact);
      }
    } catch (error) {
      console.warn(`[STORE] Data percakapan tidak dapat dibaca: ${error.message}`);
    }
  }

  ensureContact(id, metadata = {}) {
    const existing = this.contacts.get(id);
    if (existing) {
      if (metadata.contactName) existing.contactName = String(metadata.contactName);
      if (metadata.isSaved !== undefined) existing.isSaved = Boolean(metadata.isSaved);
      return existing;
    }

    const contact = cleanContact({ id, phone: id, ...metadata });
    this.contacts.set(id, contact);
    return contact;
  }

  addIncoming(id, body, metadata = {}) {
    const contact = this.ensureContact(id, metadata);
    const timestamp = metadata.timestamp || new Date().toISOString();
    const message = {
      id: crypto.randomUUID(),
      direction: 'in',
      body: String(body),
      timestamp,
      triggers: []
    };
    contact.messages.push(message);
    contact.unread += 1;
    this.updateContactFromMessage(contact, message);
    this.scheduleSave();
    return { message, contact: this.toSummary(contact) };
  }

  addOutgoing(id, body, metadata = {}) {
    const contact = this.ensureContact(id, metadata);
    const message = {
      id: crypto.randomUUID(),
      direction: 'out',
      body: String(body),
      timestamp: metadata.timestamp || new Date().toISOString(),
      triggers: Array.isArray(metadata.triggers) ? metadata.triggers : [],
      sentBy: metadata.sentBy === 'sales' ? 'sales' : 'bot'
    };
    contact.messages.push(message);
    this.updateContactFromMessage(contact, message);
    this.scheduleSave();
    return { message, contact: this.toSummary(contact) };
  }

  updateContactFromMessage(contact, message) {
    if (contact.messages.length > this.maxMessages) {
      contact.messages.splice(0, contact.messages.length - this.maxMessages);
    }
    contact.lastMessage = message.body;
    contact.lastMessageAt = message.timestamp;
    contact.lastDirection = message.direction;
    contact.project = inferProject(message.body, message.triggers) || contact.project;
  }

  list() {
    return [...this.contacts.values()]
      .sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')))
      .map(contact => this.toSummary(contact));
  }

  get(id) {
    const contact = this.contacts.get(id);
    return contact ? JSON.parse(JSON.stringify(contact)) : null;
  }

  isBotPaused(id) {
    return Boolean(this.contacts.get(id)?.botPaused);
  }

  markRead(id) {
    const contact = this.contacts.get(id);
    if (!contact) return null;
    contact.unread = 0;
    this.scheduleSave();
    return this.toSummary(contact);
  }

  setBotPaused(id, paused) {
    const contact = this.ensureContact(id);
    contact.botPaused = Boolean(paused);
    this.scheduleSave();
    return this.toSummary(contact);
  }

  setLeadStatus(id, status) {
    if (!LEAD_STATUSES.has(status)) return null;
    const contact = this.ensureContact(id);
    contact.leadStatus = status;
    this.scheduleSave();
    return this.toSummary(contact);
  }

  toSummary(contact) {
    const { messages, ...summary } = contact;
    return { ...summary, messageCount: messages.length };
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify({ version: 1, contacts: [...this.contacts.values()] }, null, 2);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, payload);
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (_) {
      fs.writeFileSync(this.filePath, payload);
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
}

module.exports = { ConversationStore, inferProject, LEAD_STATUSES };
