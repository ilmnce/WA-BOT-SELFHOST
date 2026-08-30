'use strict';

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatIndonesianPhone(value) {
  const digits = digitsOnly(value);
  if (!digits) return '';
  if (digits.startsWith('62')) return `0${digits.slice(2)}`;
  if (digits.startsWith('0')) return digits;
  return `+${digits}`;
}

function normalizePhoneId(value) {
  const digits = digitsOnly(String(value || '').split('@')[0]);
  return digits ? `${digits}@c.us` : null;
}

async function resolveWhatsAppIdentity(client, rawId) {
  const whatsappId = String(rawId || '');
  const isLid = whatsappId.endsWith('@lid');
  let phoneId = isLid ? null : normalizePhoneId(whatsappId);
  let linkedId = isLid ? whatsappId : null;

  if (isLid && client?.getContactLidAndPhone) {
    try {
      const [mapping] = await client.getContactLidAndPhone([whatsappId]);
      phoneId = normalizePhoneId(mapping?.pn) || phoneId;
      linkedId = mapping?.lid || linkedId;
    } catch (error) {
      // Mapping dapat gagal sementara ketika cache WhatsApp belum siap.
      // Raw ID tetap valid sebagai fallback untuk menerima dan membalas pesan.
    }
  }

  const phone = phoneId ? phoneId.split('@')[0] : null;
  return {
    id: phoneId || whatsappId,
    phone,
    displayPhone: phone ? formatIndonesianPhone(phone) : null,
    whatsappId,
    linkedId,
    aliases: [...new Set([whatsappId, linkedId].filter(Boolean))],
    isResolved: Boolean(phoneId)
  };
}

module.exports = { digitsOnly, formatIndonesianPhone, normalizePhoneId, resolveWhatsAppIdentity };
