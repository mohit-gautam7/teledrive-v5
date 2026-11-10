import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@/lib/direct-parts") return next(new URL("../lib/direct-parts.ts", import.meta.url).href, context);
  return next(specifier, context);
}});
const { signInBrowser, assertDirectAccount, directConfig, forgetDirectSession } = await import("../lib/direct-upload.ts");

const config = { enabled: true, apiId: 1, apiHash: "test-only" };
const account = { firstName: "Test" };
let phoneCalls = 0;
let qrCalls = 0;
const handlers = {
  phoneNumber: "+919999999999",
  onCode: async viaApp => { assert.equal(viaApp, true); return "12345"; },
  onPassword: async hint => { assert.equal(hint, "hint"); return "test-password"; },
  onQr: () => assert.fail("Phone login must not ask for a QR scan")
};
const client = {
  async signInUser(credentials, params) {
    phoneCalls++;
    assert.equal(credentials.apiId, 1);
    assert.equal(params.phoneNumber, handlers.phoneNumber);
    assert.equal(await params.phoneCode(true), "12345");
    assert.equal(await params.password("hint"), "test-password");
    await assert.rejects(params.firstAndLastNames(), /existing Telegram account/);
    await assert.rejects(params.onError(new Error("PHONE_CODE_INVALID")), /PHONE_CODE_INVALID/);
    return account;
  },
  async signInUserWithQrCode(credentials, params) {
    qrCalls++;
    await params.qrCode({ token: new Uint8Array([251, 255]), expires: 10 });
    await assert.rejects(params.onError(new Error("Login cancelled.")), /Login cancelled/);
    return account;
  }
};
assert.equal(await signInBrowser(client, config, handlers), account);
assert.equal(phoneCalls, 1);
assert.equal(qrCalls, 0);
assert.equal(await signInBrowser(client, config, {
  ...handlers, phoneNumber: undefined,
  onQr: (url, expiry) => {
    assert.equal(url, "tg://login?token=-_8");
    assert.equal(expiry, 10000);
  }
}), account);
assert.equal(qrCalls, 1);
assert.doesNotThrow(() => assertDirectAccount({ ...config, telegramUserId: "1" }, "1"));
assert.throws(() => assertDirectAccount({ ...config, telegramUserId: "1" }, "2"), /different Telegram account/);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("network offline"); };
await assert.rejects(directConfig(), /network offline/);
globalThis.fetch = async () => Response.json({ enabled: false }, { status: 403 });
assert.equal(await directConfig(), null, "a failed status lookup must be retried, not remembered as off");
forgetDirectSession();
globalThis.fetch = async () => new Response("down", { status: 503 });
await assert.rejects(directConfig(), /No file bytes were sent/);
forgetDirectSession();
globalThis.fetch = originalFetch;
console.log("direct login: phone code, 2FA, error handling, signup prevention and QR passed");
