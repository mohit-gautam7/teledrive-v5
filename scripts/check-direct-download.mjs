import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
registerHooks({resolve(specifier, context, next) {
  if (specifier === '@/lib/direct-upload') return {url:'data:text/javascript,'+encodeURIComponent('export const browserLinked=u=>globalThis.linked;export async function* downloadDirect(...a){yield* globalThis.direct(...a);}'),shortCircuit:true};
  if (specifier.startsWith('@/')) return next(new URL('../'+specifier.slice(2)+'.ts',import.meta.url).href,context);
  return next(specifier,context);
}});
process.env.NEXT_PUBLIC_FILE_ORIGIN='https://files.invalid';
let saved=[],server=0;
globalThis.window={showSaveFilePicker:async()=>({createWritable:async()=>({write:async c=>saved.push(...c),close:async()=>{},abort:async()=>{saved=[];}})}),setTimeout};
globalThis.fetch=async path=>{
  if(path==='/api/auth/file-token') return Response.json({token:'t'});
  server++;return new Response(new Uint8Array([9,9]));
};
const {downloadWithProgress}=await import('../lib/download-manager.ts');
const run=()=>downloadWithProgress({url:'/api/download/f',filename:'a',sizeHint:3,onProgress(){},direct:{user:'u',messageId:7}});

globalThis.linked=true;globalThis.direct=async function*(user,id){assert.equal(id,7);yield new Uint8Array([1,2]);yield new Uint8Array([3]);};
assert.equal(await run(),'saved');assert.deepEqual(saved,[1,2,3]);assert.equal(server,0,'direct download must not touch the file server');

saved=[];globalThis.direct=async function*(){throw new Error('AUTH_KEY_UNREGISTERED');};
await run();assert.deepEqual(saved,[9,9]);assert.equal(server,1,'a failed direct start falls back to the file server');

saved=[];server=0;globalThis.direct=async function*(){yield new Uint8Array([1]);throw new Error('dropped');};
await assert.rejects(run(),/dropped/);assert.equal(server,0,'a mid-file failure must not append server bytes to a partial file');

saved=[];globalThis.linked=false;await run();assert.equal(server,1,'unlinked browser uses the file server');
let nativeBytes=[],ended=0,aborted=0;
globalThis.window.Capacitor={Plugins:{Backup:{saveBegin:async()=>({id:'n'}),saveWrite:async({data})=>nativeBytes.push(...Buffer.from(data,'base64')),saveEnd:async()=>{ended++;return {path:'Downloads/a'};},saveAbort:async()=>{aborted++;}}}};
globalThis.linked=true;globalThis.direct=async function*(){yield new Uint8Array([4,5]);yield new Uint8Array([6]);};server=0;
assert.equal(await run(),'saved');assert.deepEqual(nativeBytes,[4,5,6]);assert.equal(ended,1);assert.equal(server,0);
globalThis.direct=async function*(){yield new Uint8Array([1]);throw new Error('dropped');};
await assert.rejects(run(),/dropped/);assert.equal(aborted,1,'native partial file must be deleted');
console.log('direct-download: direct read, fallback before first byte, no splice mid-file, unlinked, native Downloads sink passed');
