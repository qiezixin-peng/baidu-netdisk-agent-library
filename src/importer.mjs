import fs from 'node:fs';
import readline from 'node:readline';
import { extensionOf } from './db.mjs';

export async function importJsonl(db, filename) {
  const input = fs.createReadStream(filename, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const upsertItem = db.prepare(`
    INSERT INTO items(source_id,fs_id,path,parent_path,name,is_dir,size,server_mtime,category,md5,extension,open_url)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id,path) DO UPDATE SET
      fs_id=excluded.fs_id, parent_path=excluded.parent_path, name=excluded.name,
      is_dir=excluded.is_dir, size=excluded.size, server_mtime=excluded.server_mtime,
      category=excluded.category, md5=excluded.md5, extension=excluded.extension,
      open_url=excluded.open_url
  `);
  const upsertArchiveEntry = db.prepare(`
    INSERT INTO archive_entries(item_id,internal_path,parent_internal_path,name,is_dir,size,extension,crc32)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id,internal_path) DO UPDATE SET
      parent_internal_path=excluded.parent_internal_path, name=excluded.name,
      is_dir=excluded.is_dir, size=excluded.size, extension=excluded.extension,
      crc32=excluded.crc32
  `);
  const upsertArchiveScan = db.prepare(`
    INSERT INTO archive_scans(item_id,status,provider,errno,message,entry_count,scanned_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET status=excluded.status, provider=excluded.provider,
      errno=excluded.errno, message=excluded.message, entry_count=excluded.entry_count,
      scanned_at=excluded.scanned_at
  `);
  let sourceMeta = null;
  let archiveMeta = null;
  let count = 0;
  let archiveEntries = 0;
  db.exec('BEGIN');
  try {
    for await (const raw of lines) {
      if (!raw.trim()) continue;
      const value = JSON.parse(raw);
      if (value.type === 'source') {
        sourceMeta = value;
        continue;
      }
      if (value.type === 'archive') {
        archiveMeta = value;
        if (value.replace_entries && value.item_id) {
          db.prepare('DELETE FROM archive_entries WHERE item_id=?').run(value.item_id);
        }
        continue;
      }
      if (value.type === 'archive_entry') {
        const isDir = value.is_dir ? 1 : 0;
        upsertArchiveEntry.run(
          value.item_id, value.internal_path, value.parent_internal_path,
          value.name, isDir, Number(value.size || 0),
          value.extension || extensionOf(value.name, isDir), value.crc32 || null
        );
        archiveEntries += 1;
        continue;
      }
      if (value.type !== 'item') continue;
      const isDir = value.is_dir ? 1 : 0;
      upsertItem.run(
        value.source_id, String(value.fs_id || ''), value.path, value.parent_path,
        value.name, isDir, Number(value.size || 0), value.server_mtime || null,
        value.category ?? null, value.md5 || null,
        value.extension || extensionOf(value.name, isDir), value.open_url || null
      );
      count += 1;
    }
    if (sourceMeta?.source_id) {
      const emptyUnverified = Boolean(sourceMeta.complete) && count === 0 && sourceMeta.empty_confirmed !== true;
      db.prepare(`UPDATE sources SET
        name=CASE WHEN ?!='' THEN ? ELSE name END,
        root_name=CASE WHEN ?!='' THEN ? ELSE root_name END,
        last_scan_at=?, scan_status=?, item_count=(SELECT COUNT(*) FROM items WHERE source_id=?), error=? WHERE id=?`)
        .run(sourceMeta.name || '', sourceMeta.name || '', sourceMeta.root_name || '', sourceMeta.root_name || '',
          sourceMeta.scanned_at || new Date().toISOString(), emptyUnverified ? 'error' : sourceMeta.complete ? 'complete' : 'partial',
          sourceMeta.source_id, emptyUnverified ? 'empty_scan_unverified' : null, sourceMeta.source_id);
      if (emptyUnverified) sourceMeta.complete = false;
    }
    if (archiveMeta?.item_id) {
      upsertArchiveScan.run(
        archiveMeta.item_id, archiveMeta.status || 'complete', archiveMeta.provider || 'baidu_zipfile',
        archiveMeta.errno ?? null, archiveMeta.message || null,
        archiveMeta.entry_count ?? archiveEntries, archiveMeta.scanned_at || new Date().toISOString()
      );
    }
    if (!sourceMeta?.source_id && !archiveMeta?.item_id) throw new Error('导入文件缺少 source 或 archive 元数据');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    sourceId: sourceMeta?.source_id || null,
    archiveItemId: archiveMeta?.item_id || null,
    imported: count,
    archiveEntries,
    complete: Boolean(sourceMeta?.complete || archiveMeta?.status === 'complete')
  };
}
