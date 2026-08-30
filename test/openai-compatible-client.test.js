'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callChatCompletion } = require('../src/openai-compatible-client');

test('calls an OpenAI-compatible NVIDIA endpoint without exposing reasoning content', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { reasoning_content: 'internal', content: '{"reply_text":"Halo","trigger_actions":[]}' } }] })
    };
  };

  const result = await callChatCompletion({
    apiKey: 'test-key',
    baseUrl: 'https://integrate.api.nvidia.com/v1/',
    model: 'openai/gpt-oss-120b',
    systemPrompt: 'system',
    prompt: 'halo',
    fetchImpl
  });

  assert.equal(request.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'openai/gpt-oss-120b');
  assert.equal(request.body.stream, false);
  assert.equal(result, '{"reply_text":"Halo","trigger_actions":[]}');
});

test('classifies provider authentication and rate-limit errors', async () => {
  const createFetch = status => async () => ({
    ok: false,
    status,
    json: async () => ({ error: { message: 'provider error' } })
  });
  const input = { apiKey: 'x', baseUrl: 'https://example.test/v1', model: 'model', systemPrompt: 's', prompt: 'p' };

  await assert.rejects(() => callChatCompletion({ ...input, fetchImpl: createFetch(401) }), error => error.kind === 'auth_error');
  await assert.rejects(() => callChatCompletion({ ...input, fetchImpl: createFetch(429) }), error => error.kind === 'rpm');
});
