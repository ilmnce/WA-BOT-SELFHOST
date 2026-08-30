'use strict';

function apiError(status, message) {
  const error = new Error(message || `HTTP ${status}`);
  error.status = status;
  if (status === 401) error.kind = 'auth_error';
  else if (status === 403) error.kind = 'quota';
  else if (status === 429) error.kind = 'rpm';
  else error.kind = 'other';
  return error;
}

async function callChatCompletion({
  apiKey,
  baseUrl,
  model,
  systemPrompt,
  prompt,
  historyText = '',
  temperature = 0.7,
  topP = 1,
  maxTokens = 4096,
  timeoutMs = 45000,
  fetchImpl = fetch
}) {
  const userContent = historyText
    ? `${historyText}\n\nPESAN TERBARU PROSPEK: ${prompt}`
    : `PESAN PROSPEK: ${prompt}`;
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      stream: false
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw apiError(response.status, payload?.error?.message);
  }

  const payload = await response.json();
  return payload.choices?.[0]?.message?.content ?? '';
}

module.exports = { apiError, callChatCompletion };
