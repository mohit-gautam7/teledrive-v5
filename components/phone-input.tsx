"use client";

import { useState } from "react";
import { COUNTRIES, DEFAULT_COUNTRY, countryForNumber, flag, fullNumber } from "@/lib/countries";

const SORTED = [...COUNTRIES].sort((a, b) => a[1].localeCompare(b[1]));

/**
 * Country picker (India first by default) plus the number itself. Reports the
 * full international number, e.g. "+919876543210", or "" while incomplete.
 * Typing a number that already starts with "+" picks its country.
 */
export function PhoneInput({ onChange, disabled, autoFocus }: { onChange: (full: string) => void; disabled?: boolean; autoFocus?: boolean }) {
  const [iso, setIso] = useState(DEFAULT_COUNTRY);
  const [typed, setTyped] = useState("");
  const dial = COUNTRIES.find(c => c[0] === iso)?.[2] ?? "91";
  const update = (nextIso: string, nextTyped: string) => {
    const detected = countryForNumber(nextTyped);
    const chosen = detected && COUNTRIES.find(c => c[0] === nextIso)?.[2] !== COUNTRIES.find(c => c[0] === detected)?.[2] ? detected : nextIso;
    setIso(chosen);
    setTyped(nextTyped);
    onChange(fullNumber(chosen, nextTyped));
  };
  return (
    <div className="flex w-full gap-2">
      {/* Shows just "🇮🇳 +91"; the native list underneath has full names. */}
      <label className="field relative flex shrink-0 cursor-pointer items-center gap-1.5 px-3" style={{ minWidth: "5.75rem" }}>
        <span aria-hidden>{flag(iso)}</span>
        <span className="mono">+{dial}</span>
        <span aria-hidden style={{ color: "var(--text-3)" }}>▾</span>
        <select
          value={iso}
          disabled={disabled}
          onChange={e => update(e.target.value, typed)}
          aria-label="Country"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          {SORTED.map(([code, name, d]) => (
            <option key={code} value={code}>{`${flag(code)} ${name} (+${d})`}</option>
          ))}
        </select>
      </label>
      <input
        value={typed}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={e => update(iso, e.target.value)}
        placeholder={iso === "IN" ? "98765 43210" : "Phone number"}
        className="field min-w-0 flex-1"
        inputMode="tel"
        autoComplete="tel-national"
        aria-label={`Telegram phone number, after +${dial}`}
      />
    </div>
  );
}
