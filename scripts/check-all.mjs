import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = readdirSync(new URL('.', import.meta.url))
  .filter(name => /^check-.*\.mjs$/.test(name) && name !== 'check-all.mjs').sort();
let failed = 0;
for (const script of scripts) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { stdio: 'inherit' });
  if (result.status !== 0) { failed++; console.error(`FAILED: ${script}`, result.error?.message || ''); }
}
console.log(`${scripts.length - failed}/${scripts.length} regression scripts passed.`);
process.exitCode = failed ? 1 : 0;
