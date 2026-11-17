import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openDatabase, serializeArchiveEntry, serializeItem, syncConfiguredSources } from './db.mjs';
import { importJsonl } from './importer.mjs';
import { createDownloadJob, createServer, enqueueImportJob } from './server.mjs';
import { projectRoot } from './paths.mjs';
import { getAccessToken, getOpenUserInfo, openApiReadiness } from './baidu-open-api.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const db = command === 'serve' ? null : openDatabase();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function parseSelection(values) {
  const itemIds = [];
  const archiveEntryIds = [];
  for (const token of values.flatMap(value => value.split(','))) {
    const match = token.match(/^(item|entry):(\d+)$/i);
    if (!match) continue;
    (match[1].toLowerCase() === 'item' ? itemIds : archiveEntryIds).push(Number(match[2]));
  }
  return { itemIds, archiveEntryIds };
}

function parseLastJsonLine(text, fallbackError = 'worker_no_structured_result') {
  const line = String(text || '').split(/\r?\n/).filter(value => value.trim().startsWith('{')).at(-1);
  if (!line) return { ok: false, error: String(text || fallbackError).trim() || fallbackError };
  try { return JSON.parse(line); } catch { return { ok: false, error: fallbackError, raw: line.slice(0, 500) }; }
}

function startImportWorker() {
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'process-import-jobs.mjs')], {
    cwd: projectRoot, detached: true, windowsHide: true, stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

function runEgoScript(filename, globals = {}) {
  return new Promise((resolve, reject) => {
    const moduleUrl = pathToFileURL(filename).href;
    const assignments = Object.entries(globals).map(([key, value]) => `globalThis[${JSON.stringify(key)}]=${JSON.stringify(value)};`).join('');
    const child = spawn('ego-browser', ['nodejs', '-e', `${assignments}await import(${JSON.stringify(moduleUrl)})`], {
      cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(`${stdout}${stderr}`.trim()) : reject(new Error(stderr || stdout || `ego-browser exit=${code}`)));
  });
}

try {
  if (command === 'init') {
    const sources = syncConfiguredSources(db);
    console.log(JSON.stringify({ ok: true, sources: sources.length }, null, 2));
  } else if (command === 'auth') {
    console.log(await runEgoScript(path.join(projectRoot, 'scripts', 'agent-auth.mjs')));
  } else if (command === 'fast-auth') {
    console.log(await runEgoScript(path.join(projectRoot, 'scripts', 'agent-open-auth.mjs'), { BAIDU_FORCE_AUTHORIZATION: args.includes('--force') }));
  } else if (command === 'fast-status') {
    console.log(JSON.stringify(openApiReadiness(), null, 2));
  } else if (command === 'doctor') {
    syncConfiguredSources(db);
    const sources = db.prepare('SELECT id,name,scan_status,item_count,error FROM sources WHERE enabled=1 ORDER BY id').all();
    const archiveCoverage = db.prepare(`SELECT
      COUNT(*) archives_total,
      SUM(CASE WHEN a.status='complete' THEN 1 ELSE 0 END) archives_complete
      FROM items i LEFT JOIN archive_scans a ON a.item_id=i.id
      WHERE i.extension IN ('zip','rar')`).get();
    const pendingImports = db.prepare("SELECT COUNT(*) count FROM import_jobs WHERE status NOT IN ('complete','error')").get().count;
    const pendingDownloads = db.prepare("SELECT COUNT(*) count FROM download_jobs WHERE status NOT IN ('complete','cancelled')").get().count;
    const openApi = openApiReadiness();
    const accessToken = await getAccessToken().catch(() => null);
    const account = accessToken ? await getOpenUserInfo(accessToken).catch(() => null) : null;
    const issues = sources
      .filter(source => source.scan_status !== 'complete' || Number(source.item_count || 0) === 0)
      .map(source => ({ type: 'source', sourceId: source.id, name: source.name, status: source.scan_status, itemCount: source.item_count, error: source.error }));
    if (Number(archiveCoverage.archives_total || 0) !== Number(archiveCoverage.archives_complete || 0)) {
      issues.push({ type: 'archive_coverage', ...archiveCoverage });
    }
    console.log(JSON.stringify({
      ok: issues.length === 0,
      readyForSearch: sources.some(source => source.scan_status === 'complete' && Number(source.item_count || 0) > 0),
      readyForFastImport: openApi.configured && openApi.authorized,
      readyForDownload: account?.membership === 'svip',
      account: { membership: account?.membership || 'unknown', vipType: account?.vipType ?? null },
      openApi,
      archiveCoverage,
      pendingImports,
      pendingDownloads,
      issues,
    }, null, 2));
  } else if (command === 'account-status') {
    const accessToken = await getAccessToken();
    if (!accessToken) console.log(JSON.stringify({ authenticated: false, membership: 'unknown' }, null, 2));
    else console.log(JSON.stringify({ authenticated: true, ...await getOpenUserInfo(accessToken) }, null, 2));
  } else if (command === 'account-switch') {
    console.log(await runEgoScript(path.join(projectRoot, 'scripts', 'agent-switch-account.mjs')));
  } else if (command === 'account-bind') {
    const browser = await runEgoScript(path.join(projectRoot, 'scripts', 'agent-auth.mjs'));
    const browserResult = JSON.parse(browser.split(/\r?\n/).filter(line => line.trim().startsWith('{')).at(-1));
    if (!browserResult.authenticated) console.log(browser);
    else {
      const authorization = await runEgoScript(path.join(projectRoot, 'scripts', 'agent-open-auth.mjs'), { BAIDU_FORCE_AUTHORIZATION: true });
      console.log(authorization);
    }
  } else if (command === 'status') {
    syncConfiguredSources(db);
    const sources = db.prepare('SELECT id,name,scan_status,item_count,last_scan_at,error FROM sources ORDER BY id').all();
    const totals = db.prepare(`SELECT
      (SELECT COUNT(*) FROM items) items,
      (SELECT SUM(is_dir) FROM items) folders,
      (SELECT COUNT(*) FROM archive_entries) archive_entries,
      (SELECT COUNT(*) FROM archive_scans WHERE status='complete') archives_complete,
      (SELECT COUNT(*) FROM items WHERE extension IN ('zip','rar','7z','tar','gz')) archives_total`).get();
    console.log(JSON.stringify({ ...totals, sources }, null, 2));
  } else if (command === 'add-share') {
    if (!args[0]) throw new Error('用法：node src/cli.mjs add-share <链接或整段分享文字> [提取码]');
    syncConfiguredSources(db);
    const result = enqueueImportJob(db, { url: args[0], pwd: args[1] || '', rescan: args.includes('--rescan') });
    const workerPid = result.status === 'queued' ? startImportWorker() : null;
    const { httpStatus, ...output } = result;
    console.log(JSON.stringify({ ...output, workerPid }, null, 2));
  } else if (command === 'job') {
    const jobId = Number(args[0]);
    if (!jobId) throw new Error('用法：node src/cli.mjs job <任务ID>');
    const job = db.prepare(`SELECT j.*,s.name,s.scan_status,s.item_count
      FROM import_jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=?`).get(jobId);
    if (!job) throw new Error(`找不到导入任务 ${jobId}`);
    console.log(JSON.stringify(job, null, 2));
  } else if (command === 'job-resume') {
    const jobId = Number(args[0]);
    if (!jobId) throw new Error('用法：node src/cli.mjs job-resume <任务ID>');
    const changed = db.prepare(`UPDATE import_jobs SET status='queued',stage='resuming',message='账号已切换，等待 Agent 恢复任务',updated_at=?
      WHERE id=? AND status IN ('waiting_svip','error')`).run(new Date().toISOString(), jobId);
    if (!changed.changes) throw new Error(`任务 ${jobId} 当前不可恢复`);
    console.log(JSON.stringify({ ok: true, jobId, status: 'queued', workerPid: startImportWorker() }, null, 2));
  } else if (command === 'jobs') {
    const jobs = db.prepare(`SELECT j.*,s.name,s.scan_status,s.item_count
      FROM import_jobs j JOIN sources s ON s.id=j.source_id ORDER BY j.id DESC LIMIT 100`).all();
    console.log(JSON.stringify({ jobs }, null, 2));
  } else if (command === 'plan' || command === 'download') {
    const { itemIds, archiveEntryIds } = parseSelection(args);
    const result = createDownloadJob(db, { itemIds, archiveEntryIds });
    if (result.error) throw new Error(result.error);
    const { httpStatus, ...output } = result;
    if (command === 'plan') console.log(JSON.stringify(output, null, 2));
    else {
      const accessToken = await getAccessToken();
      const account = accessToken ? await getOpenUserInfo(accessToken).catch(() => null) : null;
      if (account?.membership !== 'svip') {
        console.log(JSON.stringify({
          ...output,
          ok: false,
          status: 'queued',
          needsUserAction: 'scan_svip_qr',
          currentMembership: account?.membership || 'unknown',
          nextCommand: 'node src/cli.mjs account-switch',
          resumeCommand: `node src/cli.mjs download-run ${result.jobId}`,
        }, null, 2));
      } else {
        const worker = await runEgoScript(path.join(projectRoot, 'scripts', 'agent-download-worker.mjs'), { BAIDU_DOWNLOAD_JOB_ID: result.jobId });
        console.log(JSON.stringify({ ...output, worker: JSON.parse(worker.split(/\r?\n/).filter(line => line.trim().startsWith('{')).at(-1)) }, null, 2));
      }
    }
  } else if (command === 'inspect') {
    const { itemIds, archiveEntryIds } = parseSelection(args);
    const result = createDownloadJob(db, { itemIds, archiveEntryIds, mode: 'preview' });
    if (result.error) throw new Error(result.error);
    const workerText = await runEgoScript(path.join(projectRoot, 'scripts', 'agent-download-worker.mjs'), { BAIDU_DOWNLOAD_JOB_ID: result.jobId });
    const worker = parseLastJsonLine(workerText);
    const entries = db.prepare('SELECT id,kind,name,internal_path,size,status,output_path,error FROM download_job_entries WHERE job_id=? ORDER BY id').all(result.jobId);
    const textExtensions = new Set(['txt', 'md', 'json', 'csv', 'xml', 'html', 'htm', 'log', 'srt', 'lrc']);
    const previews = entries.map(entry => {
      const extension = path.extname(entry.name || '').slice(1).toLowerCase();
      let textContent = null;
      if (entry.status === 'complete' && entry.output_path && textExtensions.has(extension)) {
        try {
          const stat = fs.statSync(entry.output_path);
          if (stat.isFile() && stat.size <= 2 * 1024 * 1024) textContent = fs.readFileSync(entry.output_path, 'utf8').slice(0, 64 * 1024);
        } catch {}
      }
      return { ...entry, textContent };
    });
    console.log(JSON.stringify({ ...result, worker, previews, cleanupCommand: `node src/cli.mjs preview-clean ${result.jobId}` }, null, 2));
  } else if (command === 'preview-run') {
    const jobId = Number(args[0]);
    if (!jobId) throw new Error('用法：node src/cli.mjs preview-run <预览任务ID>');
    const job = db.prepare("SELECT * FROM download_jobs WHERE id=? AND mode='preview'").get(jobId);
    if (!job) throw new Error(`找不到预览任务 ${jobId}`);
    const workerText = await runEgoScript(path.join(projectRoot, 'scripts', 'agent-download-worker.mjs'), { BAIDU_DOWNLOAD_JOB_ID: jobId });
    const worker = parseLastJsonLine(workerText);
    const previews = db.prepare('SELECT id,kind,name,internal_path,size,status,output_path,error FROM download_job_entries WHERE job_id=? ORDER BY id').all(jobId);
    console.log(JSON.stringify({ ok: worker.ok !== false, jobId, worker, previews, cleanupCommand: `node src/cli.mjs preview-clean ${jobId}` }, null, 2));
  } else if (command === 'preview-clean') {
    const jobId = Number(args[0]);
    if (!jobId) throw new Error('用法：node src/cli.mjs preview-clean <预览任务ID>');
    const job = db.prepare("SELECT * FROM download_jobs WHERE id=? AND mode='preview'").get(jobId);
    if (!job) throw new Error(`找不到预览任务 ${jobId}`);
    const expected = path.resolve('D:/三喜/临时文件', `百度网盘内容预览-${jobId}`);
    const output = job.output_dir ? path.resolve(job.output_dir) : expected;
    if (output !== expected) throw new Error('unsafe_preview_cleanup_path');
    fs.rmSync(output, { recursive: true, force: true });
    db.prepare("UPDATE download_jobs SET status='cancelled',message='临时预览已清理',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), jobId);
    console.log(JSON.stringify({ ok: true, jobId, removed: output }, null, 2));
  } else if (command === 'download-run') {
    const jobId = Number(args[0]);
    if (!jobId) throw new Error('用法：node src/cli.mjs download-run <下载任务ID>');
    const job = db.prepare('SELECT * FROM download_jobs WHERE id=?').get(jobId);
    if (!job) throw new Error(`找不到下载任务 ${jobId}`);
    const accessToken = await getAccessToken();
    const account = accessToken ? await getOpenUserInfo(accessToken).catch(() => null) : null;
    if (account?.membership !== 'svip') {
      console.log(JSON.stringify({
        ok: false, jobId, status: job.status, needsUserAction: 'scan_svip_qr',
        currentMembership: account?.membership || 'unknown',
        nextCommand: 'node src/cli.mjs account-switch',
        resumeCommand: `node src/cli.mjs download-run ${jobId}`,
      }, null, 2));
    } else console.log(await runEgoScript(path.join(projectRoot, 'scripts', 'agent-download-worker.mjs'), { BAIDU_DOWNLOAD_JOB_ID: jobId }));
  } else if (command === 'download-jobs') {
    const jobs = db.prepare('SELECT * FROM download_jobs ORDER BY id DESC LIMIT 100').all();
    console.log(JSON.stringify({ jobs }, null, 2));
  } else if (command === 'wait') {
    const jobId = Number(args[0]);
    const timeoutSeconds = Math.max(1, Math.min(7200, Number(args[1] || 3600)));
    if (!jobId) throw new Error('用法：node src/cli.mjs wait <任务ID> [超时秒数]');
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastProgress = -1;
    for (;;) {
      const job = db.prepare(`SELECT j.*,s.name,s.scan_status,s.item_count
        FROM import_jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=?`).get(jobId);
      if (!job) throw new Error(`找不到导入任务 ${jobId}`);
      if (job.progress !== lastProgress || ['complete', 'error'].includes(job.status)) {
        console.log(JSON.stringify(job));
        lastProgress = job.progress;
      }
      if (['complete', 'error', 'waiting_svip'].includes(job.status)) break;
      if (Date.now() >= deadline) throw new Error(`等待任务 ${jobId} 超时`);
      await sleep(2000);
    }
  } else if (command === 'import') {
    if (!args[0]) throw new Error('用法：node src/cli.mjs import <jsonl文件>');
    syncConfiguredSources(db);
    console.log(JSON.stringify(await importJsonl(db, path.resolve(args[0])), null, 2));
  } else if (command === 'import-dir') {
    if (!args[0]) throw new Error('用法：node src/cli.mjs import-dir <目录> [文件名前缀]');
    syncConfiguredSources(db);
    const directory = path.resolve(args[0]);
    const prefix = args[1] || '';
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.startsWith(prefix))
      .map(entry => path.join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));
    const results = [];
    for (const filename of files) results.push(await importJsonl(db, filename));
    console.log(JSON.stringify({ ok: true, directory, prefix, files: files.length, results }, null, 2));
  } else if (command === 'search') {
    const q = args.join(' ').trim();
    const rows = db.prepare(`SELECT i.*,s.name source_name FROM items i JOIN sources s ON s.id=i.source_id WHERE i.name LIKE ? OR i.path LIKE ? ORDER BY i.is_dir DESC,i.name LIMIT 200`).all(`%${q}%`, `%${q}%`).map(serializeItem);
    const archiveRows = db.prepare(`SELECT e.*,i.name archive_name,i.path archive_path,i.source_id,s.name source_name
      FROM archive_entries e JOIN items i ON i.id=e.item_id JOIN sources s ON s.id=i.source_id
      WHERE (e.name LIKE ? OR e.internal_path LIKE ?) AND e.name NOT LIKE '._%' AND e.internal_path NOT LIKE '%/__MACOSX/%'
      ORDER BY e.is_dir DESC,e.name LIMIT 200`)
      .all(`%${q}%`, `%${q}%`).map(serializeArchiveEntry);
    const coverage = db.prepare(`SELECT
      COUNT(*) archives_total,
      SUM(CASE WHEN a.status='complete' THEN 1 ELSE 0 END) archives_indexed
      FROM items i LEFT JOIN archive_scans a ON a.item_id=i.id
      WHERE i.extension IN ('zip','rar')`).get();
    console.log(JSON.stringify({ query: q, count: rows.length + archiveRows.length, coverage: {
      ...coverage, archives_pending: Number(coverage.archives_total || 0) - Number(coverage.archives_indexed || 0),
      exhaustive: Number(coverage.archives_total || 0) === Number(coverage.archives_indexed || 0),
    }, items: rows, archiveEntries: archiveRows }, null, 2));
  } else if (command === 'browse') {
    const sourceId = Number(args[0] || 1);
    const parentPath = args[1] || '/';
    const rows = db.prepare('SELECT * FROM items WHERE source_id=? AND parent_path=? ORDER BY is_dir DESC,name LIMIT 1000').all(sourceId, parentPath).map(serializeItem);
    console.log(JSON.stringify({ sourceId, path: parentPath, items: rows }, null, 2));
  } else if (command === 'archive') {
    const itemId = Number(args[0]);
    if (!itemId) throw new Error('用法：node src/cli.mjs archive <物料ID> [压缩包内路径]');
    const internalPath = args[1] || '/';
    const archive = db.prepare(`SELECT i.*,s.name source_name,a.status archive_status,a.errno,a.message,a.entry_count,a.scanned_at
      FROM items i JOIN sources s ON s.id=i.source_id LEFT JOIN archive_scans a ON a.item_id=i.id WHERE i.id=?`).get(itemId);
    if (!archive) throw new Error(`找不到物料 ID ${itemId}`);
    const entries = db.prepare('SELECT * FROM archive_entries WHERE item_id=? AND parent_internal_path=? ORDER BY is_dir DESC,name COLLATE NOCASE LIMIT 2000')
      .all(itemId, internalPath).map(serializeArchiveEntry);
    console.log(JSON.stringify({ archive: serializeItem(archive), path: internalPath, entries }, null, 2));
  } else if (command === 'archive-queue') {
    syncConfiguredSources(db);
    const rows = db.prepare(`SELECT i.id item_id,i.source_id,i.fs_id,i.path,i.name,i.size,i.extension,
      s.name source_name,s.root_name,s.url,s.pwd,COALESCE(a.status,'pending') archive_status
      FROM items i JOIN sources s ON s.id=i.source_id LEFT JOIN archive_scans a ON a.item_id=i.id
      WHERE i.extension IN ('zip','rar','7z','tar','gz') AND COALESCE(a.status,'pending')!='complete'
      ORDER BY i.source_id,i.path`).all();
    const output = JSON.stringify({ generated_at: new Date().toISOString(), archives: rows }, null, 2);
    if (args[0]) {
      const filename = path.resolve(args[0]);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, output + '\n', 'utf8');
      console.log(JSON.stringify({ ok: true, filename, count: rows.length }, null, 2));
    } else console.log(output);
  } else if (command === 'serve') {
    const port = Number(process.env.MATERIAL_LIBRARY_PORT || 3210);
    const app = createServer({ port });
    const info = await app.listen();
    console.log(`百度网盘物料库已启动：http://${info.host}:${info.port}`);
  } else {
    console.log('Agent 命令：doctor | auth | fast-auth [--force] | fast-status | account-status | account-switch | account-bind | add-share <链接或整段分享文字> [提取码] | job <ID> | job-resume <ID> | jobs | wait <ID> [秒] | search <关键词> | inspect item:<ID> entry:<ID> | preview-run <任务ID> | preview-clean <任务ID> | plan item:<ID> entry:<ID> | download item:<ID> entry:<ID> | download-run <任务ID> | download-jobs');
  }
} finally {
  db?.close();
}
