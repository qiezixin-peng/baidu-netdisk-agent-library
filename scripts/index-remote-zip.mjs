// ZIP 备用索引器：使用 zip.js 的 HTTP Range 读取中央目录，不下载整个压缩包。
import { HttpRangeReader, ZipReader } from '@zip.js/zip.js';
import { extensionOf, openDatabase } from '../src/db.mjs';

const itemId = Number(process.argv[2]);
const remoteUrl = process.argv[3];
if (!itemId || !remoteUrl) {
  throw new Error('用法：node scripts/index-remote-zip.mjs <物料ID> <支持Range的ZIP直链>');
}

const db = openDatabase();
const item = db.prepare('SELECT id,extension FROM items WHERE id=?').get(itemId);
if (!item) throw new Error(`找不到物料 ID ${itemId}`);
if (item.extension !== 'zip') throw new Error('远程分段读取兜底目前只支持 ZIP');

const reader = new ZipReader(new HttpRangeReader(remoteUrl, {
  checkResourceChanges: true,
  maximumRangeSize: 4 * 1024 * 1024
}));
const normalize = value => '/' + String(value || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
const parentOf = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) || '/' : '/';
const entries = await reader.getEntries();
const records = new Map();
for (const entry of entries) {
  const internalPath = normalize(entry.filename);
  if (internalPath === '/') continue;
  const isDir = Boolean(entry.directory);
  records.set(internalPath, {
    internalPath, parentPath: parentOf(internalPath), name: internalPath.split('/').pop(),
    isDir, size: Number(entry.uncompressedSize || 0), crc32: entry.signature == null ? null : String(entry.signature)
  });
  let parent = parentOf(internalPath);
  while (parent !== '/') {
    if (!records.has(parent)) records.set(parent, {
      internalPath: parent, parentPath: parentOf(parent), name: parent.split('/').pop(),
      isDir: true, size: 0, crc32: null
    });
    parent = parentOf(parent);
  }
}
await reader.close();

const upsertEntry = db.prepare(`INSERT INTO archive_entries(item_id,internal_path,parent_internal_path,name,is_dir,size,extension,crc32)
  VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(item_id,internal_path) DO UPDATE SET
  parent_internal_path=excluded.parent_internal_path,name=excluded.name,is_dir=excluded.is_dir,
  size=excluded.size,extension=excluded.extension,crc32=excluded.crc32`);
const upsertScan = db.prepare(`INSERT INTO archive_scans(item_id,status,provider,errno,message,entry_count,scanned_at)
  VALUES(?,'complete','zipjs_range',NULL,NULL,?,?) ON CONFLICT(item_id) DO UPDATE SET
  status='complete',provider='zipjs_range',errno=NULL,message=NULL,entry_count=excluded.entry_count,scanned_at=excluded.scanned_at`);
db.exec('BEGIN');
try {
  db.prepare('DELETE FROM archive_entries WHERE item_id=?').run(itemId);
  for (const record of records.values()) {
    upsertEntry.run(itemId, record.internalPath, record.parentPath, record.name, record.isDir ? 1 : 0,
      record.size, extensionOf(record.name, record.isDir), record.crc32);
  }
  upsertScan.run(itemId, records.size, new Date().toISOString());
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
console.log(JSON.stringify({ ok: true, itemId, provider: 'zipjs_range', entries: records.size }, null, 2));
