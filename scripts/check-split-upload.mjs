// A file past one Telegram message goes up as numbered pieces, a failure part-way
// resumes from the next piece, and the confirm names every piece in order.
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
registerHooks({resolve(specifier, context, next) {
  if (specifier === '@/lib/direct-upload') return {url:'data:text/javascript,'+encodeURIComponent('export class DirectUploadUnavailable extends Error{};export const uploadDirect=(...args)=>globalThis.directTest(...args);'),shortCircuit:true};
  if(specifier.startsWith('@/')) return next(new URL('../'+specifier.slice(2)+'.ts',import.meta.url).href,context);
  return next(specifier,context);
}});
const {uploadFileInChunks}=await import('../lib/chunked-upload.ts');
const {DIRECT_MAX_BYTES}=await import('../lib/direct-parts.ts');
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};

const size=2*DIRECT_MAX_BYTES+123;
// A stand-in for a 4 GB file: slices are tiny but name their byte range.
const big={name:'movie.mkv',size,type:'video/x-matroska',lastModified:1,slice:(a,b)=>new Blob([`${a}-${b}`])};
const sent=[];let failOn=null,confirmed=null,progress=0;
globalThis.directTest=async({file,caption,onProgress})=>{
  if(sent.length===failOn){failOn=null;throw new Error('network dropped');}
  sent.push({name:file.name,range:await file.text(),caption});onProgress(10);
  return {messageId:100+sent.length};
};
globalThis.fetch=async(path,options)=>{
  if(path==='/api/auth/file-token') return Response.json({token:'t'});
  if(path==='/api/upload/init') return Response.json({fileId:'s',totalChunks:1,received:[],backend:'mtproto'});
  if(path==='/api/upload/direct/s'){confirmed=JSON.parse(options.body);return Response.json({file:{id:'s'}});}
  throw new Error('Unexpected request (a split file must never relay): '+path);
};
const params={file:big,user:'u',onProgress:b=>{progress=b;}};

failOn=1;
await assert.rejects(uploadFileInChunks(params),/Finished parts are kept/);
assert.equal(sent.length,1);assert.equal(confirmed,null);

await uploadFileInChunks(params);
assert.deepEqual(sent.map(s=>s.name),['movie.mkv.001','movie.mkv.002','movie.mkv.003'],'pieces are numbered and the first is not re-sent');
assert.deepEqual(sent.map(s=>s.range),[`0-${DIRECT_MAX_BYTES}`,`${DIRECT_MAX_BYTES}-${2*DIRECT_MAX_BYTES}`,`${2*DIRECT_MAX_BYTES}-${size}`]);
assert.match(sent[2].caption,/part 3 of 3/);
assert.deepEqual(confirmed,{messageIds:[101,102,103]});
assert.equal(progress,size);
assert.equal(storage.size,0,'receipt cleared after confirm');
console.log('split upload: numbered pieces, resume after a failed piece, ordered confirm, no relay passed');
