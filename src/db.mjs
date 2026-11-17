import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databasePath, dataDir, sourcesPath } from './paths.mjs';

export function openDatabase() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      root_name TEXT NOT NULL,
      url TEXT NOT NULL,
      pwd TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at TEXT,
      scan_status TEXT NOT NULL DEFAULT 'not_scanned',
      item_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      fs_id TEXT,
      path TEXT NOT NULL,
      parent_path TEXT NOT NULL,
      name TEXT NOT NULL,
      is_dir INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      server_mtime INTEGER,
      category INTEGER,
      md5 TEXT,
      extension TEXT NOT NULL DEFAULT '',
      open_url TEXT,
      UNIQUE(source_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_items_source_parent ON items(source_id, parent_path);
    CREATE INDEX IF NOT EXISTS idx_items_name ON items(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_items_extension ON items(extension);
    CREATE TABLE IF NOT EXISTS archive_scans (
      item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      provider TEXT NOT NULL DEFAULT 'baidu_zipfile',
      errno INTEGER,
      message TEXT,
      entry_count INTEGER NOT NULL DEFAULT 0,
      scanned_at TEXT
    );
    CREATE TABLE IF NOT EXISTS archive_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      internal_path TEXT NOT NULL,
      parent_internal_path TEXT NOT NULL,
      name TEXT NOT NULL,
      is_dir INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      extension TEXT NOT NULL DEFAULT '',
      crc32 TEXT,
      UNIQUE(item_id, internal_path)
    );
    CREATE INDEX IF NOT EXISTS idx_archive_entries_parent ON archive_entries(item_id, parent_internal_path);
    CREATE INDEX IF NOT EXISTS idx_archive_entries_name ON archive_entries(name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT 'waiting_for_agent',
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status, updated_at);
    CREATE TABLE IF NOT EXISTS download_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'queued',
      item_count INTEGER NOT NULL DEFAULT 0,
      total_size INTEGER NOT NULL DEFAULT 0,
      output_dir TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS download_job_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('item','archive_entry')),
      item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
      archive_entry_id INTEGER REFERENCES archive_entries(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      source_id INTEGER,
      archive_name TEXT,
      internal_path TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      output_path TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_download_entries_job ON download_job_entries(job_id, status);
  `);
}

export function syncConfiguredSources(db) {
  if (!fs.existsSync(sourcesPath)) return [];
  const configured = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
  const upsert = db.prepare(`
    INSERT INTO sources(id,name,root_name,url,pwd,enabled)
    VALUES(?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, root_name=excluded.root_name,
      url=excluded.url, pwd=excluded.pwd, enabled=1
  `);
  db.exec('BEGIN');
  try {
    for (const source of configured) {
      upsert.run(source.id, source.name, source.rootName, source.url, source.pwd || '');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return configured;
}

export function extensionOf(name, isDir) {
  if (isDir) return '';
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext.length <= 20 ? ext : '';
}

export function classifyItem(row) {
  if (row.is_dir) return 'folder';
  const ext = row.extension;
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return 'video';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(ext)) return 'document';
  return 'other';
}

export function serializeItem(row) {
  return {
    ...row,
    is_dir: Boolean(row.is_dir),
    type: classifyItem(row)
  };
}

export function serializeArchiveEntry(row) {
  return {
    ...row,
    is_dir: Boolean(row.is_dir),
    type: row.is_dir ? 'folder' : 'archive_entry'
  };
}
