import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase } from '../src/db.mjs';
import { importJsonl } from '../src/importer.mjs';
import { openApiReadiness } from '../src/baidu-open-api.mjs';

const projectRoot = 'D:/三喜/Agent工具/百度网盘物料库';
const tempRoot = 'D:/三喜/临时文件';
let savedBrowserSession = null;
try { savedBrowserSession = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'runtime', 'browser-session.json'), 'utf8')); } catch {}
const taskSpaceId = Number(process.env.BAIDU_TASK_SPACE_ID || savedBrowserSession?.spaceId || 32);
const pageLabel = process.env.BAIDU_IMPORT_PAGE || process.argv[2] || savedBrowserSession?.pageLabel || 'p6';
const db = openDatabase();

function updateJob(id, status, stage, progress, message = '') {
  db.prepare(`UPDATE import_jobs SET status=?,stage=?,progress=?,message=?,updated_at=? WHERE id=?`)
    .run(status, stage, progress, message, new Date().toISOString(), id);
}

function runEgo(source, onEvent = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('ego-browser', ['nodejs'], { cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    let eventChain = Promise.resolve();
    const consumeLine = line => {
      if (!onEvent || !line.trim().startsWith('{')) return;
      try {
        const event = JSON.parse(line);
        eventChain = eventChain.then(() => onEvent(event));
      } catch {}
    };
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      stdout += text;
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
    child.on('error', reject);
    child.on('close', code => {
      consumeLine(pendingLine);
      eventChain.then(() => code === 0 ? resolve(stdout) : reject(new Error(`ego-browser exit=${code}: ${stderr || stdout}`)), reject);
    });
    child.stdin.end(source);
  });
}

async function processJob(job) {
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(job.source_id);
  if (!source) throw new Error(`source_not_found:${job.source_id}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const taskDir = path.join(tempRoot, `百度网盘自动导入-${job.id}-${stamp}`);
  await fsp.mkdir(taskDir, { recursive: true });
  const sourceSpec = {
    id: source.id,
    name: source.name,
    rootName: source.root_name || '',
    url: source.url,
    pwd: source.pwd || '',
  };
  let imported = null;
  let fastSucceeded = false;
  let fastNeedsSvip = false;
  let folderExport = null;
  let folderError = null;
  const fastReady = openApiReadiness();
  if (fastReady.configured && fastReady.authorized) {
    updateJob(job.id, 'running', 'fast_transfer', 8, '正在服务端转存并使用 listall 快速递归索引');
    const fastRunner = `
globalThis.BAIDU_MATERIAL_SPACE_ID=${JSON.stringify(taskSpaceId)};
globalThis.BAIDU_SCAN_PAGE_LABEL=${JSON.stringify(pageLabel)};
globalThis.BAIDU_FAST_SOURCE=${JSON.stringify(sourceSpec)};
globalThis.BAIDU_FAST_JOB_ID=${job.id};
await import('file:///D:/三喜/Agent工具/百度网盘物料库/scripts/ego-fast-index.mjs');
`;
    try {
      await runEgo(fastRunner, async event => {
        if (event.fastProgress) {
          updateJob(job.id, 'running', 'fast_listall', Math.min(58, 15 + Number(event.pages || 0) * 7),
            `listall 已读取 ${Number(event.count || 0)} 项`);
        }
        if (event.fastIndex === true && event.filename && fs.existsSync(event.filename)) {
          imported = await importJsonl(db, event.filename);
          fastSucceeded = true;
        }
        if (event.reason === 'svip_transfer_required') fastNeedsSvip = true;
      });
    } catch (error) {
      updateJob(job.id, 'running', 'fast_fallback', 9, `快速通道不可用，自动回退：${error.message}`);
    }
  }

  if (fastNeedsSvip) {
    updateJob(job.id, 'waiting_svip', 'awaiting_svip', 9,
      '分享规模超过普通账号快速转存限制；等待扫码临时 SVIP，绑定后恢复同一任务');
    return;
  }

  if (!fastSucceeded) {
  updateJob(job.id, 'running', 'scanning_folders', 10,
    fastReady.configured ? '快速通道未完成，正在回退递归读取分享目录' : '正在递归读取分享目录');
  const folderRunner = `
globalThis.BAIDU_MATERIAL_SPACE_ID=${JSON.stringify(taskSpaceId)};
globalThis.BAIDU_SCAN_PAGE_LABEL=${JSON.stringify(pageLabel)};
globalThis.BAIDU_SCAN_SOURCES=${JSON.stringify([sourceSpec])};
globalThis.BAIDU_SCAN_SOURCE_IDS=[${source.id}];
globalThis.BAIDU_SCAN_STATE_DIR=${JSON.stringify(taskDir.replaceAll('\\', '/'))};
globalThis.BAIDU_SCAN_CONCURRENCY=24;
await import('file:///D:/三喜/Agent工具/百度网盘物料库/scripts/ego-export.mjs');
`;
  await runEgo(folderRunner, async event => {
    if (Number(event.source) === Number(source.id) && event.exported === true && event.filename) folderExport = event;
    if (Number(event.source) === Number(source.id) && event.exported === false) folderError = event.error || '目录扫描失败';
    if (event.checkpoint !== true || !event.filename || !fs.existsSync(event.filename)) return;
    await importJsonl(db, event.filename);
    const discovered = Number(event.items || 0);
    const processed = Number(event.processedDirs || 0);
    const queued = Number(event.queuedDirs || 0);
    const ratio = processed + queued > 0 ? processed / (processed + queued) : 0;
    updateJob(job.id, 'running', 'scanning_folders', 10 + Math.min(50, Math.round(ratio * 50)),
      `已发现 ${discovered} 项，可先搜索；目录仍在后台扫描`);
  });
  if (!folderExport?.filename || !fs.existsSync(folderExport.filename)) {
    throw new Error(`本轮目录扫描未生成结果: ${folderError || 'unknown'}`);
  }
  if (folderExport.complete !== true) throw new Error(folderExport.items === 0 ? 'empty_scan_unverified' : '目录扫描未完整结束');
  }
  const sourceFile = fastSucceeded
    ? path.join(projectRoot, 'data', 'import', `source-${source.id}.jsonl`)
    : folderExport.filename;
  if (!fs.existsSync(sourceFile)) throw new Error('目录扫描未生成导入文件');
  if (!imported) imported = await importJsonl(db, sourceFile);
  updateJob(job.id, 'running', 'scanning_archives', 65,
    `${fastSucceeded ? '快速目录' : '目录'}已导入 ${imported.imported} 项，正在读取压缩包内部`);

  const archives = db.prepare(`SELECT i.id item_id,i.source_id,i.fs_id,i.path,i.name,i.size,i.extension,
    s.name source_name,s.root_name,s.url,s.pwd,COALESCE(a.status,'pending') archive_status
    FROM items i JOIN sources s ON s.id=i.source_id LEFT JOIN archive_scans a ON a.item_id=i.id
    WHERE i.source_id=? AND i.extension IN ('zip','rar') AND COALESCE(a.status,'pending')!='complete'
    ORDER BY i.path`).all(source.id);
  if (archives.length) {
    const queueFile = path.join(taskDir, 'archive-queue.json');
    await fsp.writeFile(queueFile, JSON.stringify({ generated_at: new Date().toISOString(), archives }, null, 2), 'utf8');
    const archiveRunner = `
globalThis.BAIDU_MATERIAL_SPACE_ID=${JSON.stringify(taskSpaceId)};
globalThis.BAIDU_ARCHIVE_PAGE_LABEL=${JSON.stringify(pageLabel)};
globalThis.BAIDU_ARCHIVE_QUEUE=${JSON.stringify(queueFile.replaceAll('\\', '/'))};
globalThis.BAIDU_ARCHIVE_SOURCE_IDS=[${source.id}];
globalThis.BAIDU_ARCHIVE_TEMP_ROOT=${JSON.stringify(`/Agent自动导入_${job.id}`)};
globalThis.BAIDU_ARCHIVE_BATCH_SIZE=24;
globalThis.BAIDU_ARCHIVE_CONCURRENCY=12;
await import('file:///D:/三喜/Agent工具/百度网盘物料库/scripts/ego-index-zip-via-transfer.mjs');
`;
    let processedArchives = 0;
    const importedArchiveIds = new Set();
    await runEgo(archiveRunner, async event => {
      if (event.indexed !== true && event.indexed !== false) return;
      const itemId = Number(event.item);
      if (!itemId || importedArchiveIds.has(itemId) || !event.filename || !fs.existsSync(event.filename)) return;
      await importJsonl(db, event.filename);
      importedArchiveIds.add(itemId);
      processedArchives += 1;
      const progress = 65 + Math.min(34, Math.round((processedArchives / archives.length) * 34));
      updateJob(job.id, 'running', 'scanning_archives', progress,
        `普通目录已可使用；压缩包已索引 ${processedArchives}/${archives.length}`);
    });
    for (const archive of archives) {
      const filename = path.join(projectRoot, 'data', 'import', `archive-${archive.item_id}.jsonl`);
      if (!importedArchiveIds.has(archive.item_id) && fs.existsSync(filename)) await importJsonl(db, filename);
    }
  }
  updateJob(job.id, 'complete', 'ready', 100, `导入完成：${imported.imported} 项，${archives.length} 个压缩包`);
}

try {
  const jobs = db.prepare("SELECT * FROM import_jobs WHERE status='queued' ORDER BY id").all();
  for (const job of jobs) {
    const claimed = db.prepare(`UPDATE import_jobs SET status='running',stage='claimed_by_agent',message='Agent 已接管任务',updated_at=?
      WHERE id=? AND status='queued'`).run(new Date().toISOString(), job.id);
    if (!claimed.changes) continue;
    try {
      await processJob(job);
    } catch (error) {
      updateJob(job.id, 'error', 'failed', 0, error.message);
    }
  }
} finally {
  db.close();
}
