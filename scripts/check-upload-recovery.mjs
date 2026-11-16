import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/api-client') return { url: 'data:text/javascript,' + encodeURIComponent(
    'export class UploadAbortedError extends Error {}; export const fileFetch=(...args)=>globalThis.fetch(...args);'
  ), shortCircuit: true };
  if (specifier === '@/lib/direct-upload') return { url: 'data:text/javascript,' + encodeURIComponent(
    'export class DirectUploadUnavailable extends Error {}; export const uploadDirect=()=>{throw new Error("unexpected direct upload")};'
  ), shortCircuit: true };
  if (specifier.startsWith('@/')) return next(new URL('../' + specifier.slice(2) + '.ts', import.meta.url).href, context);
  return next(specifier, context);
}});
const { uploadFileInChunks } = await import('../lib/chunked-upload.ts');
const file = new File(['abcdefgh'], 'recovery.txt', { lastModified: 1 });
let requests, attempts, reply, received, completeReply, controller, cancelDuringWait;
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => realTimeout(() => {
  if (cancelDuringWait) controller.abort();
  else fn();
}, 0);
globalThis.fetch = async (path) => {
  requests.push(path);
  if (path === '/api/upload/init') return Response.json({ fileId: 'one', backend: 'bot', totalChunks: 2, chunkSizeBytes: 4, received });
  if (path.includes('/chunk/')) { attempts++; return reply(path); }
  if (path.includes('/complete/')) return completeReply();
  throw new Error('Unexpected request: ' + path);
};
function reset() {
  requests = []; attempts = 0; received = [0]; cancelDuringWait = false;
  controller = new AbortController(); completeReply = () => Response.json({ file: { id: 'one' } });
}
const run = () => uploadFileInChunks({ file, user: 'test', signal: controller.signal, onProgress() {} });
try {
  reset(); reply = () => Response.json({ error: 'invalid chunk' }, { status: 400 });
  await assert.rejects(run(), /invalid chunk/);
  assert.equal(attempts, 1, 'permanent refusal must fail immediately');
  assert.ok(!requests.some(p => p.includes('/abort/')), 'failure must retain resumable progress');

  reset(); reply = () => Response.json({ error: 'wait' }, { status: 429, headers: { 'retry-after': '7200' } });
  await assert.rejects(run(), /rate-limiting/);
  assert.equal(attempts, 1, 'long flood wait must surface instead of sleeping for hours');

  for (const status of [408, 425, 429, 500]) {
    reset(); reply = () => attempts < 2 ? Response.json({}, { status }) : Response.json({ ok: true });
    await run(); assert.equal(attempts, 2);
    assert.ok(!requests.some(p => p.endsWith('/chunk/one/0')), 'confirmed chunk must not be re-sent');
  }

  reset(); reply = () => { throw new TypeError('offline'); };
  await assert.rejects(run(), /offline/);
  assert.equal(attempts, 5);
  assert.ok(!requests.some(p => p.includes('/abort/')));

  reset(); cancelDuringWait = true; reply = () => Response.json({}, { status: 500 });
  await assert.rejects(run(), error => error.constructor.name === 'UploadAbortedError');
  assert.equal(attempts, 1, 'cancel must interrupt retry backoff');

  reset(); reply = () => Response.json({}); completeReply = () => Response.json({});
  await assert.rejects(run(), /confirmation was incomplete/);
  console.log('upload recovery: permanent errors, rate limits, transient retries, resume, cancellation and incomplete confirmation passed');
} finally { globalThis.setTimeout = realTimeout; }
