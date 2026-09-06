import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageId, normalizeMessageId, messageLookupKey } from '../src/services/message-identity.js';
import { messageCenterMarkup } from '../src/services/messages.js';

test('message IDs have 16 readable alphanumeric characters and accept pasted grouping', () => {
  const ids = Array.from({ length: 100 }, () => createMessageId());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => /^[A-HJ-NP-Z2-9]{16}$/.test(id)));
  assert.equal(normalizeMessageId(' abcd-efgh jklm-npqr '), 'ABCDEFGHJKLMNPQR');
});

test('recipient lookup needs the full ID and nickname, with no email involved', async () => {
  const id = 'ABCDEFGHJKLMNPQR';
  const key = await messageLookupKey(id, 'Test Player');
  assert.equal(key, await messageLookupKey(id.toLowerCase(), ' test PLAYER '));
  assert.notEqual(key, await messageLookupKey(id, 'Different Player'));
  assert.notEqual(key, await messageLookupKey('2345678923456789', 'Test Player'));
  await assert.rejects(messageLookupKey('short', 'Test Player'), /16-character/);
  await assert.rejects(messageLookupKey(id, ''), /nickname/);
});

test('Message Center exposes shareable details and asks for a Message ID instead of email', () => {
  const markup = messageCenterMarkup();
  assert.match(markup, /id="own-message-id" readonly/);
  assert.match(markup, /Copy ID & nickname/);
  assert.match(markup, /id="message-recipient-id"/);
  assert.match(markup, /id="message-nickname"/);
  assert.doesNotMatch(markup, /type="email"|message-email|Player’s email/);
});
