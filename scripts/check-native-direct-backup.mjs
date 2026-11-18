import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  const mocks = {
    '@/lib/native-backup': 'export const nativeBackup=globalThis.backup; export const nativeBackupAvailable=()=>true;',
    '@/lib/direct-upload': 'export const browserLinked=()=>true; export const directConfig=async()=>({enabled:true,apiId:7}); export const checkDirectConnection=async()=>"Test"; export const storedSession=()=>"1session";',
    '@/lib/api-client': 'export const apiFetch=async()=>({user:{id:"database-user-id"}});',
    '@/lib/backup-network': 'export const backupConnection=async()=>"wifi"; export const backupNetworkAllowed=()=>true;',
    '@/lib/chunked-upload': 'export class DuplicateFileError extends Error {}; export const uploadFileInChunks=(...args)=>globalThis.uploadTest(...args);'
  };
  if (mocks[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  if (specifier.startsWith('@/')) return next(new URL('../' + specifier.slice(2) + '.ts', import.meta.url).href, context);
  return next(specifier, context);
}});
globalThis.document = new EventTarget(); document.visibilityState = 'visible';
globalThis.window = new EventTarget();
const awake = [];
globalThis.backup = { status: async () => ({ backupVersion: 3, enabled: true, transport: 'direct', networkMode: 'wifi' }),
  keepAwake: async (enabled, owner) => awake.push({ enabled, owner }) };
let begins, acknowledgements, endings, fail, hide, readCount, wrongAccount, rejectAcknowledgement, rejectEnd;
const files = ['first', 'second'].map(id => ({ id, name: id + '.jpg', size: 3, type: 'image/jpeg', lastModified: 1 }));
window.Capacitor = { Plugins: { Backup: {
  directBegin: async ({ accountId }) => {
    assert.equal(accountId, 'database-user-id', 'the display name must not be used as the database identity');
    return { runId: String(++begins), accountId: wrongAccount ? 'another-account' : accountId, folderId: 'camera', files: begins === 1 ? files : [] };
  },
  directRead: async ({ offset, length }) => { readCount++; assert.equal(offset, 0); assert.equal(length, 3); return { data: 'YWJj' }; },
  directAcknowledge: async ({ id }) => { if (rejectAcknowledgement) throw new Error('Drive confirmation is missing'); acknowledgements.push(id); },
  directEnd: async ({ runId }) => { endings.push(runId); if (rejectEnd) throw new Error('Bridge unavailable'); }
} } };
globalThis.uploadTest = async options => {
  assert.equal(options.directOnly, true);
  assert.equal(options.folderId, 'camera');
  assert.equal(options.user, 'display-name');
  assert.equal(Buffer.from(await options.file.slice(0, 3).arrayBuffer()).toString(), 'abc');
  if (hide) { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }
  if (fail && options.file.name === 'second.jpg') throw new Error('Telegram disconnected');
  return { fileId: options.file.name };
};
const { nativeDirectBackup } = await import('../lib/native-direct-backup.ts');
function reset() {
  begins = 0; acknowledgements = []; endings = []; readCount = 0;
  fail = false; hide = false; wrongAccount = false; rejectAcknowledgement = false; rejectEnd = false;
  document.visibilityState = 'visible';
}
reset(); await nativeDirectBackup.start('display-name');
assert.deepEqual(acknowledgements, ['first', 'second']); assert.deepEqual(endings, ['1', '2']);
assert.equal(nativeDirectBackup.getSnapshot().saved, 2); assert.equal(readCount, 2);
assert.deepEqual(awake.at(-1), { enabled: false, owner: 'backup' });
reset(); fail = true; await nativeDirectBackup.start('display-name');
assert.deepEqual(acknowledgements, ['first'], 'failed files must never advance the backup cursor');
assert.deepEqual(endings, ['1']); assert.match(nativeDirectBackup.getSnapshot().message, /disconnected/);
reset(); hide = true; await nativeDirectBackup.start('display-name');
assert.deepEqual(acknowledgements, [], 'a hidden app must pause before acknowledgement');
assert.equal(nativeDirectBackup.getSnapshot().running, false); assert.deepEqual(endings, ['1']);
reset(); wrongAccount = true; await nativeDirectBackup.start('display-name');
assert.equal(readCount, 0, 'another account must not receive local media bytes');
assert.deepEqual(acknowledgements, []); assert.deepEqual(endings, ['1']);
reset(); rejectAcknowledgement = true; await nativeDirectBackup.start('display-name');
assert.equal(nativeDirectBackup.getSnapshot().saved, 0, 'an unconfirmed native acknowledgement must not report saved');
assert.match(nativeDirectBackup.getSnapshot().message, /confirmation/);
reset(); hide = true; rejectEnd = true; await nativeDirectBackup.start('display-name');
assert.equal(nativeDirectBackup.getSnapshot().running, false, 'a failing cleanup must not strand the runner');
assert.deepEqual(awake.at(-1), { enabled: false, owner: 'backup' });
reset(); await nativeDirectBackup.start('display-name');
assert.equal(nativeDirectBackup.getSnapshot().saved, 2, 'a subsequent run must recover after cleanup failure');
assert.equal(nativeDirectBackup.getSnapshot().user, 'display-name');
// App version 5: the page only hands the session to the native worker.
const handed = []; let ran = 0;
window.Capacitor.Plugins.Backup.directCredentials = async options => { handed.push(options); return { directReady: true }; };
globalThis.backup.status = async () => ({ backupVersion: 5, enabled: true, transport: 'direct', networkMode: 'wifi' });
globalThis.backup.runNow = async () => { ran++; };
reset(); await nativeDirectBackup.start('display-name');
assert.deepEqual(handed, [{ session: '1session', apiId: 7 }]); assert.equal(ran, 1);
assert.equal(readCount, 0, 'version 5 must not read bytes through the page');
assert.equal(nativeDirectBackup.getSnapshot().running, false);
console.log('native direct backup: account binding, byte reads, ordered acknowledgement, failure recovery and background pause passed');
