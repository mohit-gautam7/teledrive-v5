import assert from "node:assert/strict";
import { signInBrowser } from "../lib/direct-upload.ts";

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
console.log("direct login: phone code, 2FA, error handling, signup prevention and QR passed");
