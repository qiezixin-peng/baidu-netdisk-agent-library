import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { openDatabase, serializeArchiveEntry, serializeItem, syncConfiguredSources } from './db.mjs';
import { projectRoot, publicDir } from './paths.mjs';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function parseIntSafe(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error('request_body_too_large');
  }
  return JSON.parse(body || '{}');
}

export function normalizeShareInput(input) {
  const raw = String(input.url || input.text || '').trim();
  const urlMatch = raw.match(/https:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s，。；;]*)?/i);
  if (!urlMatch) throw new Error('invalid_baidu_share_url');
  const parsed = new URL(urlMatch[0]);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'pan.baidu.com' || !/^\/s\/[A-Za-z0-9_-]+/.test(parsed.pathname)) {
    throw new Error('invalid_baidu_share_url');
  }
  const textCode = raw.match(/(?:提取码|密码|pwd)\s*[:：=]?\s*([A-Za-z0-9]{4})/i)?.[1] || '';
  const pwd = String(input.pwd || parsed.searchParams.get('pwd') || textCode).trim();
  if (pwd && !/^[A-Za-z0-9]{4}$/.test(pwd)) throw new Error('invalid_extract_code');
  if (pwd) parsed.searchParams.set('pwd', pwd);
  parsed.hash = '';
  parsed.search = pwd ? `?pwd=${encodeURIComponent(pwd)}` : '';
  return { url: parsed.toString(), pwd, name: String(input.name || '').trim().slice(0, 120), rescan: input.rescan === true };
}

export function enqueueImportJob(db, rawInput) {
  const input = normalizeShareInput(rawInput);
  const existing = db.prepare('SELECT * FROM sources WHERE url=?').get(input.url);
  let sourceId;
  if (existing) {
    sourceId = existing.id;
    if (existing.scan_status === 'complete' && Number(existing.item_count || 0) > 0 && !input.rescan) {
      db.prepare(`UPDATE sources SET pwd=?,name=CASE WHEN ?!='' THEN ? ELSE name END WHERE id=?`)
        .run(input.pwd, input.name, input.name, sourceId);
      return { httpStatus: 200, ok: true, sourceId, status: 'complete', reused: true, message: '该分享已完整导入，无需重复扫描。' };
    }
    db.prepare(`UPDATE sources SET pwd=?,name=CASE WHEN ?!='' THEN ? ELSE name END,
      scan_status='not_scanned',error=NULL WHERE id=?`).run(input.pwd, input.name, input.name, sourceId);
  } else {
    sourceId = Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 id FROM sources').get().id);
    db.prepare(`INSERT INTO sources(id,name,root_name,url,pwd,enabled,scan_status,item_count)
      VALUES(?,?,?,?,?,1,'not_scanned',0)`).run(sourceId, input.name || `百度分享 ${sourceId}`, '', input.url, input.pwd);
  }
  const now = new Date().toISOString();
  const result = db.prepare(`INSERT INTO import_jobs(source_id,status,stage,progress,message,created_at,updated_at)
    VALUES(?,'queued','waiting_for_agent',0,'等待 Agent 读取百度分享',?,?)`).run(sourceId, now, now);
  return { httpStatus: 201, ok: true, jobId: Number(result.lastInsertRowid), sourceId, status: 'queued' };
}

function sourceRows(db) {
  return db.prepare(`SELECT id,name,root_name,url,enabled,last_scan_at,scan_status,item_count,error FROM sources ORDER BY id`).all();
}

function buildOpenUrl(sourceUrl, item) {
  const targetPath = item.is_dir ? item.path : item.parent_path;
  const separator = sourceUrl.includes('#') ? '' : '#list/path=';
  return `${sourceUrl}${separator}${encodeURIComponent(targetPath)}&vmode=list`;
}

export function createDownloadJob(db, input = {}) {
  const mode = input.mode === 'preview' ? 'preview' : 'download';
  const itemIds = [...new Set((Array.isArray(input.itemIds) ? input.itemIds : []).map(Number).filter(Number.isInteger))].slice(0, 500);
  const archiveEntryIds = [...new Set((Array.isArray(input.archiveEntryIds) ? input.archiveEntryIds : []).map(Number).filter(Number.isInteger))].slice(0, 500);
  const items = itemIds.length ? db.prepare(`SELECT i.*,s.name source_name,s.url source_url FROM items i JOIN sources s ON s.id=i.source_id WHERE i.id IN (${itemIds.map(() => '?').join(',')})`).all(...itemIds) : [];
  const archiveEntries = archiveEntryIds.length ? db.prepare(`SELECT e.*,i.name archive_name,i.path archive_path,i.source_id,s.name source_name,s.url source_url
    FROM archive_entries e JOIN items i ON i.id=e.item_id JOIN sources s ON s.id=i.source_id
    WHERE e.id IN (${archiveEntryIds.map(() => '?').join(',')})`).all(...archiveEntryIds) : [];
  const plan = [
    ...items.map(item => ({ kind: 'item', id: item.id, name: item.name, size: item.size, sourceId: item.source_id, openUrl: item.open_url || buildOpenUrl(item.source_url, item) })),
    ...archiveEntries.map(entry => ({ kind: 'archive_entry', id: entry.id, itemId: entry.item_id, name: entry.name, internalPath: entry.internal_path, size: entry.size, archiveName: entry.archive_name, sourceId: entry.source_id })),
  ];
  if (!plan.length) return { httpStatus: 400, error: 'empty_download_plan' };
  const now = new Date().toISOString();
  db.exec('BEGIN');
  let jobId;
  try {
    const created = db.prepare(`INSERT INTO download_jobs(mode,status,item_count,total_size,message,created_at,updated_at)
      VALUES(?,'queued',?,?, ?,?,?)`).run(mode, plan.length, plan.reduce((sum, entry) => sum + Number(entry.size || 0), 0),
        mode === 'preview' ? '等待 Agent 临时读取内容' : '等待 Agent 下载', now, now);
    jobId = Number(created.lastInsertRowid);
    const insert = db.prepare(`INSERT INTO download_job_entries
      (job_id,kind,item_id,archive_entry_id,name,source_id,archive_name,internal_path,size,status)
      VALUES(?,?,?,?,?,?,?,?,?,'queued')`);
    for (const entry of plan) insert.run(jobId, entry.kind, entry.kind === 'item' ? entry.id : entry.itemId,
      entry.kind === 'archive_entry' ? entry.id : null, entry.name, entry.sourceId,
      entry.archiveName || null, entry.internalPath || null, Number(entry.size || 0));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { httpStatus: 201, ok: true, jobId, mode, status: 'queued', count: plan.length, plan,
    note: mode === 'preview'
      ? '内容检查任务已保存；文件仅写入临时目录，ZIP 只提取选中条目。'
      : '下载任务已保存；Agent 将自动下载普通文件并定点提取压缩包内部文件。' };
}

export function createServer({ port = 3210, host = '127.0.0.1' } = {}) {
  const db = openDatabase();
  syncConfiguredSources(db);
  let importWorker = null;
  const startImportWorker = () => {
    if (importWorker) return;
    const script = path.join(projectRoot, 'scripts', 'process-import-jobs.mjs');
    importWorker = spawn(process.execPath, [script], { cwd: projectRoot, windowsHide: true, stdio: 'ignore' });
    importWorker.on('close', () => { importWorker = null; });
    importWorker.on('error', () => { importWorker = null; });
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
      if (url.pathname === '/api/status') {
        const totals = db.prepare(`SELECT
          (SELECT COUNT(*) FROM items) item_count,
          (SELECT SUM(CASE WHEN is_dir=1 THEN 1 ELSE 0 END) FROM items) folder_count,
          (SELECT COUNT(*) FROM archive_entries) archive_entry_count,
          (SELECT COUNT(*) FROM items WHERE extension IN ('zip','rar','7z','tar','gz')) archive_count,
          (SELECT COUNT(*) FROM archive_scans WHERE status='complete') archive_complete_count`).get();
        return json(res, 200, { ok: true, database: true, ...totals, sources: sourceRows(db) });
      }
      if (url.pathname === '/api/sources') return json(res, 200, sourceRows(db));
      if (url.pathname === '/api/imports' && req.method === 'POST') {
        const result = enqueueImportJob(db, await readJson(req));
        if (result.status === 'queued') startImportWorker();
        const { httpStatus, ...body } = result;
        return json(res, httpStatus, body);
      }
      if ((url.pathname === '/api/imports' || url.pathname === '/api/agent/import-jobs') && req.method === 'GET') {
        const jobs = db.prepare(`SELECT j.*,s.name,s.root_name,s.url,s.pwd,s.scan_status,s.item_count
          FROM import_jobs j JOIN sources s ON s.id=j.source_id ORDER BY j.id DESC LIMIT 100`).all();
        return json(res, 200, { jobs });
      }
      const importJobMatch = url.pathname.match(/^\/api\/agent\/import-jobs\/(\d+)$/);
      if (importJobMatch && req.method === 'PATCH') {
        const jobId = Number(importJobMatch[1]);
        const input = await readJson(req);
        const allowedStatus = new Set(['queued', 'running', 'waiting_svip', 'complete', 'error']);
        if (!allowedStatus.has(input.status)) return json(res, 400, { error: 'invalid_status' });
        const progress = parseIntSafe(input.progress, 0, 0, 100);
        const now = new Date().toISOString();
        db.prepare(`UPDATE import_jobs SET status=?,stage=?,progress=?,message=?,updated_at=? WHERE id=?`)
          .run(input.status, String(input.stage || ''), progress, String(input.message || ''), now, jobId);
        const job = db.prepare('SELECT * FROM import_jobs WHERE id=?').get(jobId);
        if (!job) return json(res, 404, { error: 'job_not_found' });
        return json(res, 200, { ok: true, job });
      }
      if (url.pathname === '/api/search' || url.pathname === '/api/agent/search') {
        const q = (url.searchParams.get('q') || '').trim();
        const source = parseIntSafe(url.searchParams.get('source'), 0, 0, 9999);
        const type = (url.searchParams.get('type') || '').trim();
        const includeSystem = url.searchParams.get('includeSystem') === '1';
        const limit = parseIntSafe(url.searchParams.get('limit'), 100, 1, 500);
        const offset = parseIntSafe(url.searchParams.get('offset'), 0, 0, 1_000_000);
        const where = [];
        const params = [];
        if (q) { where.push('(i.name LIKE ? ESCAPE \'\\\' OR i.path LIKE ? ESCAPE \'\\\')'); params.push(`%${q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`, `%${q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`); }
        if (source) { where.push('i.source_id=?'); params.push(source); }
        if (type === 'folder') where.push('i.is_dir=1');
        else if (type === 'archive') where.push("i.extension IN ('zip','rar','7z','tar','gz')");
        else if (type === 'audio') where.push("i.extension IN ('mp3','wav','flac','m4a','aac','ogg')");
        else if (type === 'document') where.push("i.extension IN ('pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md')");
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const rows = db.prepare(`SELECT i.*,s.name source_name,s.url source_url FROM items i JOIN sources s ON s.id=i.source_id ${clause} ORDER BY i.is_dir DESC,i.name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params, limit, offset).map(serializeItem);
        const total = db.prepare(`SELECT COUNT(*) total FROM items i ${clause}`).get(...params).total;
        let archiveEntries = [];
        let archiveEntryTotal = 0;
        if (q && (!type || type === 'archive_entry')) {
          const escaped = `%${q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
          const entryWhere = ['(e.name LIKE ? ESCAPE \'\\\' OR e.internal_path LIKE ? ESCAPE \'\\\')'];
          const entryParams = [escaped, escaped];
          if (!includeSystem) entryWhere.push("e.name NOT LIKE '._%' AND e.internal_path NOT LIKE '%/__MACOSX/%'");
          if (source) { entryWhere.push('i.source_id=?'); entryParams.push(source); }
          archiveEntries = db.prepare(`SELECT e.*,i.name archive_name,i.path archive_path,i.source_id,
            s.name source_name,s.url source_url,a.status archive_status
            FROM archive_entries e JOIN items i ON i.id=e.item_id JOIN sources s ON s.id=i.source_id
            LEFT JOIN archive_scans a ON a.item_id=i.id
            WHERE ${entryWhere.join(' AND ')} ORDER BY e.is_dir DESC,e.name COLLATE NOCASE LIMIT ? OFFSET ?`)
            .all(...entryParams, limit, offset).map(serializeArchiveEntry);
          archiveEntryTotal = db.prepare(`SELECT COUNT(*) total FROM archive_entries e JOIN items i ON i.id=e.item_id WHERE ${entryWhere.join(' AND ')}`).get(...entryParams).total;
        }
        return json(res, 200, { q, source, type, includeSystem, limit, offset, total, archiveEntryTotal, items: rows, archiveEntries });
      }
      if (url.pathname === '/api/browse' || url.pathname === '/api/agent/browse') {
        const source = parseIntSafe(url.searchParams.get('source'), 1, 1, 9999);
        const parentPath = url.searchParams.get('path') || '/';
        const rows = db.prepare(`SELECT i.*,s.name source_name,s.url source_url FROM items i JOIN sources s ON s.id=i.source_id WHERE i.source_id=? AND i.parent_path=? ORDER BY i.is_dir DESC,i.name COLLATE NOCASE LIMIT 1000`).all(source, parentPath).map(serializeItem);
        return json(res, 200, { source, path: parentPath, items: rows });
      }
      if (url.pathname === '/api/archive' || url.pathname === '/api/agent/archive') {
        const itemId = parseIntSafe(url.searchParams.get('item'), 0, 1, 2_000_000_000);
        const internalPath = url.searchParams.get('path') || '/';
        const includeSystem = url.searchParams.get('includeSystem') === '1';
        if (!itemId) return json(res, 400, { error: 'item_required' });
        const archive = db.prepare(`SELECT i.*,s.name source_name,s.url source_url,a.status archive_status,
          a.provider archive_provider,a.errno,a.message,a.entry_count,a.scanned_at
          FROM items i JOIN sources s ON s.id=i.source_id LEFT JOIN archive_scans a ON a.item_id=i.id WHERE i.id=?`).get(itemId);
        if (!archive) return json(res, 404, { error: 'item_not_found' });
        const systemClause = includeSystem ? '' : "AND name NOT LIKE '._%' AND internal_path NOT LIKE '%/__MACOSX/%'";
        const entries = db.prepare(`SELECT * FROM archive_entries WHERE item_id=? AND parent_internal_path=? ${systemClause} ORDER BY is_dir DESC,name COLLATE NOCASE LIMIT 2000`)
          .all(itemId, internalPath).map(serializeArchiveEntry);
        return json(res, 200, { archive: serializeItem(archive), path: internalPath, entries });
      }
      const archiveEntryMatch = url.pathname.match(/^\/api\/(?:agent\/)?archive-entry\/(\d+)$/);
      if (archiveEntryMatch) {
        const entry = db.prepare(`SELECT e.*,i.name archive_name,i.path archive_path,i.source_id,
          s.name source_name,s.url source_url,a.status archive_status
          FROM archive_entries e JOIN items i ON i.id=e.item_id JOIN sources s ON s.id=i.source_id
          LEFT JOIN archive_scans a ON a.item_id=i.id WHERE e.id=?`).get(Number(archiveEntryMatch[1]));
        if (!entry) return json(res, 404, { error: 'archive_entry_not_found' });
        return json(res, 200, { entry: serializeArchiveEntry(entry) });
      }
      const previewMatch = url.pathname.match(/^\/api\/(?:agent\/)?preview\/(\d+)$/);
      if (previewMatch) {
        const itemId = Number(previewMatch[1]);
        const item = db.prepare(`SELECT i.*,s.name source_name,s.url source_url,a.status archive_status,
          a.provider archive_provider,a.message archive_message,a.entry_count archive_entry_count
          FROM items i JOIN sources s ON s.id=i.source_id LEFT JOIN archive_scans a ON a.item_id=i.id WHERE i.id=?`).get(itemId);
        if (!item) return json(res, 404, { error: 'item_not_found' });
        const archiveEntries = ['zip', 'rar', '7z', 'tar', 'gz'].includes(item.extension)
          ? db.prepare("SELECT * FROM archive_entries WHERE item_id=? AND parent_internal_path=? AND name NOT LIKE '._%' AND internal_path NOT LIKE '%/__MACOSX/%' ORDER BY is_dir DESC,name COLLATE NOCASE LIMIT 500")
            .all(itemId, '/').map(serializeArchiveEntry)
          : [];
        return json(res, 200, { item: serializeItem(item), archivePath: '/', archiveEntries });
      }
      if ((url.pathname === '/api/download-plan' || url.pathname === '/api/agent/download-plan') && req.method === 'POST') {
        const result = createDownloadJob(db, await readJson(req));
        const { httpStatus, ...body } = result;
        return json(res, httpStatus, body);
      }
      if ((url.pathname === '/api/download-jobs' || url.pathname === '/api/agent/download-jobs') && req.method === 'GET') {
        const jobs = db.prepare(`SELECT * FROM download_jobs ORDER BY id DESC LIMIT 100`).all();
        return json(res, 200, { jobs });
      }
      const downloadJobMatch = url.pathname.match(/^\/api\/(?:agent\/)?download-jobs\/(\d+)$/);
      if (downloadJobMatch && req.method === 'GET') {
        const jobId = Number(downloadJobMatch[1]);
        const job = db.prepare('SELECT * FROM download_jobs WHERE id=?').get(jobId);
        if (!job) return json(res, 404, { error: 'job_not_found' });
        const entries = db.prepare('SELECT * FROM download_job_entries WHERE job_id=? ORDER BY id').all(jobId);
        return json(res, 200, { job, entries });
      }
      if (downloadJobMatch && req.method === 'PATCH') {
        const jobId = Number(downloadJobMatch[1]);
        const input = await readJson(req);
        const allowedStatus = new Set(['queued', 'running', 'complete', 'partial', 'error', 'cancelled']);
        if (!allowedStatus.has(input.status)) return json(res, 400, { error: 'invalid_status' });
        db.prepare(`UPDATE download_jobs SET status=?,message=?,output_dir=COALESCE(?,output_dir),updated_at=? WHERE id=?`)
          .run(input.status, String(input.message || ''), input.outputDir ? String(input.outputDir) : null, new Date().toISOString(), jobId);
        const job = db.prepare('SELECT * FROM download_jobs WHERE id=?').get(jobId);
        if (!job) return json(res, 404, { error: 'job_not_found' });
        return json(res, 200, { ok: true, job });
      }
      const openMatch = url.pathname.match(/^\/api\/open\/(\d+)$/);
      if (openMatch) {
        const item = db.prepare(`SELECT i.*,s.url source_url FROM items i JOIN sources s ON s.id=i.source_id WHERE i.id=?`).get(Number(openMatch[1]));
        if (!item) return json(res, 404, { error: 'item_not_found' });
        res.writeHead(302, { location: item.open_url || buildOpenUrl(item.source_url, item) });
        return res.end();
      }
      if (url.pathname === '/api/auth/status') {
        return json(res, 200, {
          authenticated: false,
          provider: 'baidu-official-browser',
          message: '登录状态由百度官方页面和 Agent 浏览器会话确认；本地项目不保存 Cookie。'
        });
      }
      if (url.pathname === '/api/auth/open' && req.method === 'POST') {
        const mode = (await readJson(req)).mode;
        if (!['qr', 'sms'].includes(mode)) return json(res, 400, { error: 'unsupported_login_mode' });
        const redirect = encodeURIComponent('https://pan.baidu.com/disk/main#/index?category=all');
        const officialUrl = `https://passport.baidu.com/v2/?login&tpl=netdisk&subpro=netdisk_web&u=${redirect}`;
        return json(res, 200, { mode, officialUrl, note: mode === 'qr' ? '请在百度官方页面扫码登录' : '请在百度官方页面选择手机号验证码登录' });
      }
      const requested = url.pathname === '/' ? '/index.html' : url.pathname;
      const filename = path.resolve(publicDir, `.${requested}`);
      if (!filename.startsWith(publicDir) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
        return json(res, 404, { error: 'not_found' });
      }
      res.writeHead(200, { 'content-type': mimeTypes[path.extname(filename)] || 'application/octet-stream' });
      fs.createReadStream(filename).pipe(res);
    } catch (error) {
      const clientErrors = new Set(['invalid_baidu_share_url', 'invalid_extract_code', 'request_body_too_large']);
      json(res, clientErrors.has(error.message) || error instanceof SyntaxError ? 400 : 500, { error: error.message });
    }
  });
  server.on('close', () => db.close());
  return { server, listen: () => new Promise(resolve => server.listen(port, host, () => resolve({ host, port }))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.slice(1))) {
  const app = createServer();
  app.listen().then(({ host, port }) => console.log(`百度网盘物料库：http://${host}:${port}`));
}
