'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const now = Date.now();

const conversations = [
  {
    id: '628123456789@c.us', phone: '628123456789', contactName: 'Andi Saputra', isSaved: false,
    project: 'PK18', leadStatus: 'qualified', botPaused: false, unread: 2,
    lastMessage: 'Kalau survei hari Minggu bisa, Kak?', lastMessageAt: new Date(now - 120000).toISOString(), lastDirection: 'in', messageCount: 4
  },
  {
    id: '628567890123@c.us', phone: '628567890123', contactName: 'Siti Rahma', isSaved: false,
    project: 'PK17', leadStatus: 'follow_up', botPaused: true, unread: 0,
    lastMessage: 'Baik, nanti saya kabari lagi.', lastMessageAt: new Date(now - 3600000).toISOString(), lastDirection: 'out', messageCount: 3
  },
  {
    id: '628777112233@c.us', phone: '628777112233', contactName: null, isSaved: false,
    project: null, leadStatus: 'new', botPaused: false, unread: 1,
    lastMessage: 'Ada rumah subsidi daerah Bogor?', lastMessageAt: new Date(now - 86400000).toISOString(), lastDirection: 'in', messageCount: 1
  }
];

const messages = {
  '628123456789@c.us': [
    { id: '1', direction: 'in', body: 'Halo Kak, saya lihat iklan PK18.', timestamp: new Date(now - 600000).toISOString(), triggers: [] },
    { id: '2', direction: 'out', body: 'Halo Kak Andi! PK18 berada di Parung Panjang, sekitar 10 menit dari KRL 😊 Mau Ariel kirimkan brosurnya?', timestamp: new Date(now - 540000).toISOString(), triggers: [], sentBy: 'bot' },
    { id: '3', direction: 'in', body: 'Boleh. Kalau survei hari Minggu bisa, Kak?', timestamp: new Date(now - 120000).toISOString(), triggers: [] },
    { id: '4', direction: 'out', body: 'Siap Kak, ini brosur resminya ya 📋✨', timestamp: new Date(now - 90000).toISOString(), triggers: ['PL_PK18'], sentBy: 'bot' }
  ],
  '628567890123@c.us': [
    { id: '5', direction: 'in', body: 'Untuk PK17 cicilannya berapa?', timestamp: new Date(now - 7200000).toISOString(), triggers: [] },
    { id: '6', direction: 'out', body: 'Untuk tenor 20 tahun sekitar Rp1,07 juta per bulan ya, Kak.', timestamp: new Date(now - 7000000).toISOString(), triggers: [], sentBy: 'sales' },
    { id: '7', direction: 'out', body: 'Baik, nanti saya kabari lagi.', timestamp: new Date(now - 3600000).toISOString(), triggers: [], sentBy: 'sales' }
  ],
  '628777112233@c.us': [
    { id: '8', direction: 'in', body: 'Ada rumah subsidi daerah Bogor?', timestamp: new Date(now - 86400000).toISOString(), triggers: [] }
  ]
};

app.use(express.static(path.join(__dirname, '..', 'public')));

io.on('connection', socket => {
  socket.emit('ready', { user: 'Ariel Preview', phone: '628000000000' });
  socket.emit('operational_status', { isBotActive: true, filterOnlyNewContacts: true, countIn: 18, countOut: 15, inHours: true });
  socket.emit('conversation_list', conversations);
  socket.on('get_conversation', ({ contactId }) => {
    const contact = conversations.find(item => item.id === contactId);
    if (contact) socket.emit('conversation_data', { ...contact, unread: 0, messages: messages[contactId] || [] });
  });
});

server.listen(4174, '127.0.0.1', () => console.log('Dashboard preview: http://127.0.0.1:4174'));
