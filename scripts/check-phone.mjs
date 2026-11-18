import assert from "node:assert/strict";
import { COUNTRIES, countryForNumber, flag, fullNumber } from "../lib/countries.ts";

assert.equal(fullNumber("IN", "98765 43210"), "+919876543210", "India is the default code");
assert.equal(fullNumber("IN", "098765 43210"), "+919876543210", "a leading trunk 0 is dropped");
assert.equal(fullNumber("IT", "06 1234 5678"), "+390612345678", "Italy keeps its 0");
assert.equal(fullNumber("IN", "+44 7700 900123"), "+447700900123", "a typed + wins over the dropdown");
assert.equal(fullNumber("IN", ""), "");

assert.equal(countryForNumber("+1 415"), "US");
assert.equal(countryForNumber("+7 912"), "RU");
assert.equal(countryForNumber("+44 7700"), "GB");
assert.equal(countryForNumber("+971 50"), "AE", "three-digit codes beat shorter ones");
assert.equal(countryForNumber("98765"), null, "no + means no guess");

assert.equal(flag("IN"), "🇮🇳");
assert.equal(new Set(COUNTRIES.map(c => c[0])).size, COUNTRIES.length, "no duplicate countries");
assert.ok(COUNTRIES.every(([, , d]) => /^[1-9]\d{0,2}$/.test(d)), "calling codes are 1–3 digits");

console.log("phone: country codes ok,", COUNTRIES.length, "countries");
