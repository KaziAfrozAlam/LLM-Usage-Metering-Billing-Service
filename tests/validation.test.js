const test = require('node:test');
const assert = require('node:assert');
const { makeContext, call, close } = require('./helpers');

test('boundary validation: missing body -> 400, never 500', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  const noBody = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' } });
  assert.equal(noBody.status, 400);
  assert.match(String(noBody.json.error), /(HttpError|SyntaxError)/i);

  const missingKey = await call(ctx, 'POST', '/generate', {
    headers: { 'X-API-Key': 'key-free' },
    body: { prompt: 'hi' },
  });
  assert.equal(missingKey.status, 400);
  assert.match(missingKey.json.message, /idempotency_key/);

  const badType = await call(ctx, 'POST', '/generate', {
    headers: { 'X-API-Key': 'key-free' },
    body: { idempotency_key: 'v-1', prompt: 'hi', max_output_tokens: 'many' },
  });
  assert.equal(badType.status, 400);
  assert.match(badType.json.message, /max_output_tokens/);

  const malformedJson = await call(ctx, 'POST', '/generate', {
    headers: { 'X-API-Key': 'key-free' },
    rawBody: '{not json',
  });
  assert.equal(malformedJson.status, 400);
});

test('no auth: missing API key -> 401', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));
  const r = await call(ctx, 'GET', '/usage');
  assert.equal(r.status, 401);
});

test('unknown route -> 404', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));
  const r = await call(ctx, 'GET', '/nope');
  assert.equal(r.status, 404);
});