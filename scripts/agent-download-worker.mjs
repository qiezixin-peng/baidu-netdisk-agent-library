// 由 ego-browser nodejs 运行：消费持久下载任务，普通文件直下，ZIP 定点 Range 提取，RAR 选择性解压。
const fs = await import('node:fs/promises');
const fsSync = await import('node:fs');
const path = await import('node:path');
const { spawn } = await import('node:child_process');
const { Readable } = await import('node:stream');
const { pipeline } = await import('node:stream/promises');
const { DatabaseSync } = await import('node:sqlite');
const { HttpRangeReader, ZipReader } = await import('file:///D:/三喜/Agent工具/百度网盘物料库/node_modules/@zip.js/zip.js/index.js');

const projectRoot = 'D:/三喜/Agent工具/百度网盘物料库';
const databasePath = `${projectRoot}/data/library.sqlite`;
const sessionFile = `${projectRoot}/data/runtime/browser-session.json`;
const downloadRoot = 'D:/三喜/下载的物料';
const workspaceTemp = path.resolve('D:/三喜/临时文件');
const pcsExecutable = `${projectRoot}/tools/BaiduPCS-Go/BaiduPCS-Go-v4.0.2-windows-x64/BaiduPCS-Go.exe`;
const requestedJobId = Number(globalThis.BAIDU_DOWNLOAD_JOB_ID || 0);
const previewMaxBytes = 256 * 1024 * 1024;

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

function safeSegment(value) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || '_';
}

function internalSegments(value) {
  const segments = String(value || '').replaceAll('\\', '/').split('/').filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..')) throw new Error(`unsafe_archive_path:${value}`);
  return segments;
}

function relativeOutputPath(value) {
  return internalSegments(value).map(safeSegment).join('/');
}

function updateJob(jobId, status, message, outputDir = null) {
  db.prepare(`UPDATE download_jobs SET status=?,message=?,output_dir=COALESCE(?,output_dir),updated_at=? WHERE id=?`)
    .run(status, message, outputDir, new Date().toISOString(), jobId);
}

function updateEntry(id, status, outputPath = null, error = null) {
  db.prepare(`UPDATE download_job_entries SET status=?,output_path=?,error=? WHERE id=?`)
    .run(status, outputPath, error, id);
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(executable)} exit=${code}: ${stderr || stdout}`)));
  });
}

async function getShareContext(page, source) {
  try { await page.goto(source.url, { timeout: 30000 }); }
  catch (error) { if (!String(error).includes('navigation committed')) throw error; }
  await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 20000 });
  if (source.root_name) {
    const clicked = await page.evaluate(name => {
      const link = [...document.querySelectorAll('a')].find(node => node.textContent?.trim() === name);
      if (!link) return false;
      link.click();
      return true;
    }, source.root_name);
    if (clicked) await page.waitForTimeout(500);
  }
  await page.waitForFunction(() => {
    const locals = window.__DISK_SHARE_V2_LOCALS__ || {};
    let dumped = {};
    try { dumped = window.locals?.dump?.() || {}; } catch {}
    const value = input => input && typeof input === 'object' && 'value' in input ? input.value : input;
    return Boolean(
      value(locals.shareid || locals.share_id || dumped.shareid) &&
      value(locals.share_uk || locals.uk || dumped.share_uk) &&
      value(locals.bdstoken || dumped.bdstoken)
    );
  }, undefined, { timeout: 20000 });
  return page.evaluate(() => {
    const locals = window.__DISK_SHARE_V2_LOCALS__ || {};
    let dumped = {};
    try { dumped = window.locals?.dump?.() || {}; } catch {}
    const value = input => input && typeof input === 'object' && 'value' in input ? input.value : input;
    const rawCookie = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('BDCLND='))?.slice(7) || '';
    return {
      shareid: String(value(locals.shareid || locals.share_id || dumped.shareid) || ''),
      shareUk: String(value(locals.share_uk || locals.uk || dumped.share_uk) || ''),
      sekey: String(value(locals.currentSekey || locals.sekey || dumped.currentSekey || dumped.sekey) || (rawCookie ? decodeURIComponent(rawCookie) : '')),
      bdstoken: String(value(locals.bdstoken || dumped.bdstoken) || ''),
    };
  });
}

async function ensureTempFolder(page, tempRoot, bdstoken) {
  return page.evaluate(async ({ tempRoot, bdstoken }) => {
    const query = new URLSearchParams({ a: 'commit', channel: 'chunlei', bdstoken, app_id: '250528' });
    const body = new URLSearchParams({ path: tempRoot, isdir: '1', size: '', block_list: '[]', method: 'post', dataType: 'json' });
    return (await fetch(`/api/create?${query}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json();
  }, { tempRoot, bdstoken });
}

async function transferBatch(page, items, share, tempRoot) {
  return page.evaluate(async ({ items, share, tempRoot }) => {
    const query = new URLSearchParams({ shareid: share.shareid, from: share.shareUk, sekey: share.sekey, ondup: 'newcopy', async: '1' });
    const body = new URLSearchParams({ fsidlist: JSON.stringify(items.map(item => String(item.fs_id))), path: tempRoot });
    return (await fetch(`/share/transfer?${query}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json();
  }, { items, share, tempRoot });
}

async function deleteTransferred(page, paths, bdstoken) {
  if (!paths.length) return;
  await page.evaluate(async ({ paths, bdstoken }) => {
    const query = new URLSearchParams({ opera: 'delete', async: '2', onnest: 'fail', channel: 'chunlei', web: '1', app_id: '250528', bdstoken });
    const body = new URLSearchParams({ filelist: JSON.stringify(paths) });
    await fetch(`/api/filemanager?${query}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  }, { paths, bdstoken });
}

async function cookieHeader(page) {
  const cookies = (await page.cdp('Network.getAllCookies')).cookies;
  return cookies.filter(cookie => cookie.domain.endsWith('baidu.com')).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

async function getMetadata(paths, cookies) {
  const result = new Map();
  for (let offset = 0; offset < paths.length; offset += 12) {
    const group = paths.slice(offset, offset + 12);
    const values = await Promise.all(group.map(async targetPath => {
      const url = new URL('https://pan.baidu.com/api/filemetas');
      url.searchParams.set('target', JSON.stringify([targetPath]));
      url.searchParams.set('dlink', '1');
      const response = await fetch(url, { headers: { cookie: cookies, referer: 'https://pan.baidu.com/disk/main', 'user-agent': 'netdisk' } });
      const data = await response.json();
      const info = Array.isArray(data.info) ? data.info[0] : Array.isArray(data.list) ? data.list[0] : null;
      return { targetPath, info, errno: data.errno };
    }));
    for (const value of values) if (value.info) result.set(value.targetPath, value.info);
  }
  return result;
}

async function downloadDirect(url, destination, cookies, expectedSize = 0) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const part = `${destination}.part`;
  let offset = 0;
  try { offset = (await fs.stat(part)).size; } catch {}
  const headers = { cookie: cookies, referer: 'https://pan.baidu.com/disk/main', 'user-agent': 'netdisk' };
  if (offset) headers.range = `bytes=${offset}-`;
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok && response.status !== 206) throw new Error(`download_http_${response.status}`);
  const append = offset > 0 && response.status === 206;
  await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(part, { flags: append ? 'a' : 'w' }));
  const finalSize = (await fs.stat(part)).size;
  if (expectedSize && finalSize !== Number(expectedSize)) throw new Error(`download_size_mismatch:${finalSize}/${expectedSize}`);
  await fs.rename(part, destination);
  return destination;
}

async function extractZip(dlink, cookies, archiveItem, selections, baseOutput) {
  const reader = new ZipReader(new HttpRangeReader(dlink, {
    headers: new Map([['User-Agent', 'netdisk'], ['Cookie', cookies]]),
    checkResourceChanges: false, maximumRangeSize: 4 * 1024 * 1024,
  }));
  try {
    const entries = await reader.getEntries();
    for (const selection of selections) {
      const wanted = internalSegments(selection.internal_path).join('/');
      const matches = entries.filter(entry => {
        const actual = String(entry.filename || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
        return selection.is_dir ? actual === wanted || actual.startsWith(`${wanted}/`) : actual === wanted;
      });
      if (!matches.length) throw new Error(`zip_entry_not_found:${selection.internal_path}`);
      for (const entry of matches) {
        if (entry.directory) continue;
        const actual = String(entry.filename).replaceAll('\\', '/').replace(/^\/+/, '');
        const destination = path.join(baseOutput, relativeOutputPath(actual));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const part = `${destination}.part`;
        const handle = await fs.open(part, 'w');
        const writable = new WritableStream({
          async write(chunk) { await handle.write(chunk); },
          async close() { await handle.close(); },
          async abort() { await handle.close().catch(() => {}); },
        });
        await entry.getData(writable);
        await fs.rename(part, destination);
      }
      updateEntry(selection.job_entry_id, 'complete', path.join(baseOutput, relativeOutputPath(selection.internal_path)));
    }
  } finally {
    await reader.close().catch(() => {});
  }
}

async function extractRar(archiveFile, selections, baseOutput, taskTemp) {
  const configFile = path.join(taskTemp, `rar-${path.basename(archiveFile)}.json`);
  await fs.writeFile(configFile, JSON.stringify({
    archiveFile,
    outputRoot: baseOutput,
    selections: selections.map(selection => ({ id: selection.job_entry_id, internalPath: selection.internal_path, isDir: selection.is_dir })),
  }), 'utf8');
  const result = await runProcess(process.execPath, [`${projectRoot}/scripts/extract-rar.mjs`, configFile], { cwd: projectRoot });
  const parsed = JSON.parse(result.stdout.split(/\r?\n/).filter(line => line.trim().startsWith('{')).at(-1));
  for (const output of parsed.outputs) updateEntry(output.id, 'complete', output.outputPath);
}

async function pcsFallback(remotePath, destinationDir, cookies, taskTemp) {
  if (!fsSync.existsSync(pcsExecutable)) throw new Error('baidupcs_go_not_installed');
  const configDir = path.join(taskTemp, 'baidupcs-config');
  await fs.mkdir(configDir, { recursive: true });
  const env = { ...process.env, BAIDUPCS_GO_CONFIG_DIR: configDir };
  await runProcess(pcsExecutable, ['login', `-cookies=${cookies}`], { env });
  await runProcess(pcsExecutable, ['config', 'set', '-max_parallel', '12', '-max_download_load', '2'], { env });
  await runProcess(pcsExecutable, ['download', remotePath, '--saveto', destinationDir, '--ow', '-p', '12', '-l', '2'], { env });
}

async function processJob(task, page, job) {
  const previewMode = job.mode === 'preview';
  const outputDir = previewMode
    ? path.resolve(workspaceTemp, `百度网盘内容预览-${job.id}`)
    : path.resolve(downloadRoot, `任务-${job.id}`);
  if (previewMode && !outputDir.startsWith(`${workspaceTemp}${path.sep}`)) throw new Error('unsafe_preview_path');
  const taskTemp = path.resolve(workspaceTemp, `百度网盘下载任务-${job.id}`);
  if (!taskTemp.startsWith(`${workspaceTemp}${path.sep}`)) throw new Error('unsafe_temp_path');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(taskTemp, { recursive: true });
  updateJob(job.id, 'running', 'Agent 正在准备百度直链', outputDir);
  const rows = db.prepare(`SELECT dje.id job_entry_id,dje.kind,dje.item_id,dje.archive_entry_id,dje.internal_path,dje.name,dje.size,dje.status,
    i.fs_id,i.path item_path,i.name item_name,i.is_dir,i.size item_size,i.extension item_extension,i.source_id,
    ae.is_dir archive_entry_is_dir,s.name source_name,s.root_name,s.url,s.pwd
    FROM download_job_entries dje JOIN items i ON i.id=dje.item_id JOIN sources s ON s.id=i.source_id
    LEFT JOIN archive_entries ae ON ae.id=dje.archive_entry_id
    WHERE dje.job_id=? AND dje.status IN ('queued','error') ORDER BY dje.id`).all(job.id);
  const sourceIds = [...new Set(rows.map(row => row.source_id))];
  let completed = 0;
  let failed = 0;
  try {
    for (const sourceId of sourceIds) {
      const sourceRows = rows.filter(row => row.source_id === sourceId);
      const source = sourceRows[0];
      const share = await getShareContext(page, source);
      const cloudRoot = `/Agent下载任务_${job.id}_${sourceId}`;
      const folder = await ensureTempFolder(page, cloudRoot, share.bdstoken);
      if (![0, -8].includes(Number(folder.errno))) throw new Error(`create_temp_folder_errno_${folder.errno}`);
      const uniqueItems = [...new Map(sourceRows.map(row => [row.item_id, row])).values()];
      const skippedEntryIds = new Set();
      const transferItems = previewMode ? uniqueItems.filter(item => {
        const related = sourceRows.filter(row => row.item_id === item.item_id);
        const archiveSelections = related.filter(row => row.kind === 'archive_entry');
        for (const row of related.filter(row => row.kind === 'item')) {
          let reason = '';
          if (item.is_dir) reason = 'folder_content_use_browse';
          else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(item.item_extension)) reason = 'archive_content_use_entry_preview';
          else if (Number(item.item_size || 0) > previewMaxBytes) reason = 'preview_too_large_select_download';
          if (reason) {
            updateEntry(row.job_entry_id, 'error', null, reason);
            skippedEntryIds.add(row.job_entry_id);
            failed += 1;
          }
        }
        return archiveSelections.length > 0 || related.some(row => row.kind === 'item' && !skippedEntryIds.has(row.job_entry_id));
      }) : uniqueItems;
      if (!transferItems.length) {
        await deleteTransferred(page, [cloudRoot], share.bdstoken).catch(() => {});
        continue;
      }
      const transfer = await transferBatch(page, transferItems, share, cloudRoot);
      if (Number(transfer.errno) !== 0) throw new Error(`transfer_errno_${transfer.errno}`);
      const transferred = Array.isArray(transfer.extra?.list) ? transfer.extra.list : [];
      const byFsId = new Map(transferred.map(entry => [String(entry.from_fs_id), entry.to]));
      const transferredPaths = transferred.map(entry => entry.to).filter(Boolean);
      const cookies = await cookieHeader(page);
      const metadata = await getMetadata(transferredPaths, cookies);
      try {
        for (const item of transferItems) {
          const related = sourceRows.filter(row => row.item_id === item.item_id && !skippedEntryIds.has(row.job_entry_id));
          const remotePath = byFsId.get(String(item.fs_id));
          const meta = remotePath ? metadata.get(remotePath) : null;
          if (!remotePath) {
            for (const row of related) updateEntry(row.job_entry_id, 'error', null, `transfer_mapping_missing:${item.item_id}`);
            failed += related.length;
            continue;
          }
          const sourceOutput = path.join(outputDir, safeSegment(item.source_name));
          const wholeRows = related.filter(row => row.kind === 'item');
          const archiveRows = related.filter(row => row.kind === 'archive_entry');
          if (wholeRows.length) {
            try {
              const destination = path.join(sourceOutput, ...String(item.item_path).split('/').filter(Boolean).map(safeSegment));
              if (previewMode && item.is_dir) throw new Error('folder_content_use_browse');
              if (previewMode && ['zip', 'rar', '7z', 'tar', 'gz'].includes(item.item_extension)) {
                throw new Error('archive_content_use_entry_preview');
              }
              if (previewMode && Number(item.item_size || 0) > previewMaxBytes) throw new Error('preview_too_large_select_download');
              if (item.is_dir) {
                await pcsFallback(remotePath, path.dirname(destination), cookies, taskTemp);
              } else {
                if (!meta?.dlink) throw new Error('dlink_missing');
                try { await downloadDirect(meta.dlink, destination, cookies, item.item_size); }
                catch { await pcsFallback(remotePath, path.dirname(destination), cookies, taskTemp); }
              }
              for (const row of wholeRows) { updateEntry(row.job_entry_id, 'complete', destination); completed += 1; }
            } catch (error) {
              for (const row of wholeRows) updateEntry(row.job_entry_id, 'error', null, error.message);
              failed += wholeRows.length;
            }
          }
          if (archiveRows.length) {
            try {
              if (!meta?.dlink) throw new Error('archive_dlink_missing');
              const archiveOutput = path.join(sourceOutput, safeSegment(path.parse(item.item_name).name));
              const selections = archiveRows.map(row => ({ ...row, is_dir: Boolean(row.archive_entry_is_dir) }));
              if (item.item_extension === 'zip') {
                await extractZip(meta.dlink, cookies, item, selections, archiveOutput);
              } else if (item.item_extension === 'rar') {
                if (previewMode) throw new Error('rar_preview_requires_full_archive');
                const archiveFile = path.join(taskTemp, `${item.item_id}-${safeSegment(item.item_name)}`);
                await downloadDirect(meta.dlink, archiveFile, cookies, item.item_size);
                await extractRar(archiveFile, selections, archiveOutput, taskTemp);
              } else throw new Error(`unsupported_archive:${item.item_extension}`);
              completed += archiveRows.length;
            } catch (error) {
              for (const row of archiveRows) updateEntry(row.job_entry_id, 'error', null, error.message);
              failed += archiveRows.length;
            }
          }
          updateJob(job.id, 'running', `已完成 ${completed}/${rows.length}，失败 ${failed}`, outputDir);
        }
      } finally {
        await deleteTransferred(page, transferredPaths.length ? transferredPaths : [cloudRoot], share.bdstoken).catch(() => {});
        await deleteTransferred(page, [cloudRoot], share.bdstoken).catch(() => {});
      }
    }
    const status = failed === 0 ? 'complete' : completed > 0 ? 'partial' : 'error';
    updateJob(job.id, status,
      `${previewMode ? '内容检查' : '下载'}完成 ${completed}/${rows.length}，失败 ${failed}`, outputDir);
    return { jobId: job.id, mode: previewMode ? 'preview' : 'download', status, completed, failed, outputDir };
  } finally {
    await fs.rm(taskTemp, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  let session = null;
  try { session = JSON.parse(await fs.readFile(sessionFile, 'utf8')); } catch {}
  if (!session?.authenticated) throw new Error('baidu_auth_required');
  const task = await taskSpace(Number(session.spaceId));
  const page = task.page(session.pageLabel);
  const jobs = requestedJobId
    ? db.prepare("SELECT * FROM download_jobs WHERE id=? AND status IN ('queued','partial','error')").all(requestedJobId)
    : db.prepare("SELECT * FROM download_jobs WHERE status='queued' ORDER BY id").all();
  const results = [];
  for (const job of jobs) results.push(await processJob(task, page, job));
  console.log(JSON.stringify({ ok: true, results }));
} catch (error) {
  if (requestedJobId) updateJob(requestedJobId, 'error', error.message);
  console.log(JSON.stringify({ ok: false, error: error.message }));
} finally {
  db.close();
}
