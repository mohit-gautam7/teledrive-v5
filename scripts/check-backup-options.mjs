import assert from 'node:assert/strict';
import {backupNetworkAllowed} from '../lib/backup-network.ts';
import {descendantFolderIds} from '../lib/backup-folders.ts';
for (const mode of ['wifi','mobile','both']) {
 for (const type of ['wifi','mobile','other','unknown','offline']) {
  assert.equal(backupNetworkAllowed(mode,type),type!=='offline'&&(mode==='both'||mode===type),mode+' / '+type);
 }
}
assert.deepEqual(new Set(descendantFolderIds('a',[{id:'a',parentId:null},{id:'b',parentId:'a'},{id:'c',parentId:'b'},{id:'foreign',parentId:null}])),new Set(['a','b','c']));
assert.deepEqual(new Set(descendantFolderIds('a',[{id:'a',parentId:'b'},{id:'b',parentId:'a'}])),new Set(['a','b']));
assert.deepEqual(descendantFolderIds('empty',[]),['empty']);
console.log('backup options: network modes fail closed, nested destinations and cyclic folder guards passed');
