import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
registerHooks({resolve(specifier, context, next) {
  if (specifier === '@/lib/direct-upload') return {url:'data:text/javascript,'+encodeURIComponent('export class DirectUploadUnavailable extends Error{};export const uploadDirect=(...args)=>globalThis.directTest(...args);'),shortCircuit:true};
  if(specifier.startsWith('@/')) return next(new URL('../'+specifier.slice(2)+'.ts',import.meta.url).href,context);
  return next(specifier,context);
}});
const {uploadFileInChunks}=await import('../lib/chunked-upload.ts');
const {saveDirectReceipt,readDirectReceipt,clearDirectReceipt}=await import('../lib/direct-receipt.ts');
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
let requests=[],uploads=0,confirmationFails=false,backend='mtproto';
globalThis.directTest=async()=>{uploads++;return {messageId:42};};
globalThis.fetch=async(path,options)=>{
  requests.push(path);
  if(path==='/api/upload/init') {
    const body=JSON.parse(options.body);assert.equal(body.prefer,'account');assert.match(body.resumeKey,/^direct\|/);
    return Response.json({fileId:'session',totalChunks:1,received:[],backend});
  }
  if(path==='/api/upload/direct/session'){
    if(confirmationFails)throw new Error('network offline');
    return Response.json({file:{id:'session'}});
  }
  throw new Error('Unexpected relay request: '+path);
};
const params={file:new File(['test'],'small.txt',{lastModified:1}),user:'test',directOnly:true,onProgress:()=>{}};
confirmationFails=true;
await assert.rejects(uploadFileInChunks(params),/No file bytes were relayed/);
assert.equal(uploads,1);assert.equal(readDirectReceipt('test','session'),42);
confirmationFails=false;
await uploadFileInChunks(params);
assert.equal(uploads,1,'confirmation retry must not upload bytes twice');
assert.equal(readDirectReceipt('test','session'),null);
backend='bot';await assert.rejects(uploadFileInChunks(params),/No file bytes were relayed/);
assert.equal(uploads,1,'wrong backend must fail before sending bytes');
backend='mtproto';globalThis.directTest=async()=>{throw new Error('Telegram offline');};
await assert.rejects(uploadFileInChunks(params),/No file bytes were relayed/);
assert.ok(requests.every(p=>!p.includes('/chunk/')&&p!=='/api/upload'),'direct errors must never relay');
saveDirectReceipt('alice','one',99);assert.equal(readDirectReceipt('bob','one'),null);clearDirectReceipt('alice','one');
console.log('direct-only: no relay on errors; small file; wrong backend; confirmation retry; account-scoped receipt passed');
