import assert from 'node:assert/strict';
import { NativeMediaFile } from '../lib/native-media-file.ts';
import { uploadDirectParts, DIRECT_PART_SIZE } from '../lib/direct-parts.ts';

const bytes = Buffer.alloc(DIRECT_PART_SIZE * 2 + 31);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
const reads = [], sent = [];
const file = new NativeMediaFile({ id: 'one', name: 'photo.jpg', type: 'image/jpeg', size: bytes.length, lastModified: 123 }, async (offset, length) => {
  reads.push({ offset, length });
  return bytes.subarray(offset, offset + length).toString('base64');
});
assert.equal(file.size, bytes.length);
assert.equal(file.name, 'photo.jpg');
assert.equal(file.lastModified, 123);
const count = await uploadDirectParts(file, async (index, part) => { sent[index] = part; return true; }, () => {});
assert.equal(count, 3);
assert.deepEqual(Buffer.concat(sent), bytes, 'native parts must reconstruct the original bytes exactly');
assert.ok(reads.every(read => read.length <= DIRECT_PART_SIZE));
assert.equal(reads.at(-1).length, 31);
await assert.rejects(file.arrayBuffer(), /whole-file buffer/);
await assert.rejects(file.slice(0, file.size).arrayBuffer(), /bounded Telegram parts/);
const short = new NativeMediaFile({ id: 'bad', name: 'short.jpg', size: 10, type: '', lastModified: 1 }, async () => 'YQ==');
await assert.rejects(short.slice(0, 10).arrayBuffer(), /incomplete/);
console.log('native media: exact byte reconstruction, short final part, bounded memory and truncated reads passed');
