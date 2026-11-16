import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  const mocks = {
    telegram: 'export class TelegramClient { constructor(session) { return globalThis.makeClient(session); } }; export const Api={auth:{LogOut:class {}}};',
    'telegram/sessions': 'export class StringSession { constructor(value) { this.value=value; } save() { return "saved-session"; } }'
  };
  if (mocks[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  if (specifier.startsWith('@/')) return next(new URL('../' + specifier.slice(2) + '.ts', import.meta.url).href, context);
  return next(specifier, context);
}});
const direct = await import('../lib/direct-upload.ts');
const storage = new Map();
globalThis.window = { localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) } };
globalThis.fetch = async () => Response.json({ enabled: true, apiId: 1, apiHash: 'test', telegramUserId: '1' });
let disconnected = 0, destroyed = 0, created = 0, revoked = false;
globalThis.makeClient = session => ({
  session,
  connect: async () => { created++; },
  // A disconnected GramJS client keeps its ping loop and reconnects itself;
  // only destroy() ends it. Counted separately so the test can tell them apart.
  disconnect: async () => { disconnected++; },
  destroy: async () => { destroyed++; },
  signInUser: async () => ({ id: 1, firstName: 'Test' }),
  getMe: async () => { if (revoked) throw new Error('SESSION_REVOKED'); return { id: 1, firstName: 'Test' }; },
  invoke: async () => {}
});
const handlers = { phoneNumber: '+919999999999', onQr() {}, onPassword: async () => '' };
try {
  await direct.linkBrowser('alice', handlers);
  assert.equal(direct.browserLinked('alice'), true);
  assert.equal(await direct.checkDirectConnection('alice'), 'Test');
  const before = created;
  await assert.rejects(direct.checkDirectConnection('bob'), /not connected/);
  assert.equal(created, before, 'another account must not reuse Alice connection');

  direct.forgetDirectSession(); revoked = true;
  await assert.rejects(direct.checkDirectConnection('alice'), /SESSION_REVOKED/);
  assert.equal(direct.browserLinked('alice'), false, 'revoked session must allow reconnect');
  revoked = false;

  await direct.linkBrowser('alice', handlers);
  await direct.checkDirectConnection('alice');
  revoked = true;
  await assert.rejects(direct.checkDirectConnection('alice'), /SESSION_REVOKED/);
  assert.equal(direct.browserLinked('alice'), false, 'a cached connection must also forget a revoked session');
  revoked = false;

  const setItem = window.localStorage.setItem;
  window.localStorage.setItem = () => { throw new Error('storage blocked'); };
  await assert.rejects(direct.linkBrowser('alice', handlers), /could not save/);
  window.localStorage.setItem = setItem;

  const make = globalThis.makeClient;
  const controller = new AbortController();
  globalThis.makeClient = session => ({ ...make(session), signInUser: () => new Promise(() => controller.abort()) });
  const destroyedBefore = destroyed;
  await assert.rejects(direct.linkBrowser('alice', { ...handlers, signal: controller.signal }), /cancelled/);
  assert.ok(destroyed > destroyedBefore, 'cancelled login must destroy its client, not merely disconnect it');
  assert.equal(direct.browserLinked('alice'), false);
  console.log('direct lifecycle: account isolation, revoked sessions, storage failures and login cancellation passed');
} finally { direct.forgetDirectSession(); }
