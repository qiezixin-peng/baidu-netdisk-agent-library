// 由 ego-browser nodejs 运行。不要直接用 node 执行。
// 可由包装脚本设置：globalThis.BAIDU_MATERIAL_SPACE_ID、BAIDU_SCAN_SOURCE_IDS、BAIDU_SCAN_MAX_DIRS。
const fs = await import('node:fs/promises');
const path = await import('node:path');

const projectRoot = 'D:/三喜/Agent工具/百度网盘物料库';
const sources = globalThis.BAIDU_SCAN_SOURCES || JSON.parse(await fs.readFile(`${projectRoot}/config/sources.json`, 'utf8'));
const selectedIds = new Set(globalThis.BAIDU_SCAN_SOURCE_IDS || sources.map(x => x.id));
const maxDirs = Number(globalThis.BAIDU_SCAN_MAX_DIRS || 0);
const concurrency = Math.max(1, Math.min(32, Number(globalThis.BAIDU_SCAN_CONCURRENCY || 16)));
const stateDir = globalThis.BAIDU_SCAN_STATE_DIR || 'D:/三喜/临时文件/百度压缩包浏览验证-20261113-004/state';
const spaceRef = globalThis.BAIDU_MATERIAL_SPACE_ID || 'baidu-material-library-indexer';
const task = await taskSpace(spaceRef);
const page = task.page(globalThis.BAIDU_SCAN_PAGE_LABEL || 'p1');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const parentOf = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) || '/' : '/';
const extensionOf = (name, isDir) => isDir ? '' : (name.includes('.') ? name.split('.').pop().toLowerCase().slice(0, 20) : '');

async function fetchListing(templateUrl, dir, pageNumber) {
  const u = new URL(templateUrl);
  u.searchParams.set('dir', dir);
  u.searchParams.set('page', String(pageNumber));
  u.searchParams.set('num', '100');
  u.searchParams.set('order', 'name');
  u.searchParams.set('desc', '0');
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await page.fetch(u.toString(), { timeout: 30000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = JSON.parse(response.body);
      if (Number(data.errno || 0) !== 0) throw new Error(`errno=${data.errno}`);
      return data.list || [];
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(250 * attempt);
    }
  }
  throw new Error(`目录接口失败 ${lastError}: ${dir}`);
}

function listingUrl(templateUrl, dir, pageNumber) {
  const u = new URL(templateUrl);
  u.searchParams.set('dir', dir);
  u.searchParams.set('page', String(pageNumber));
  u.searchParams.set('num', '100');
  u.searchParams.set('order', 'name');
  u.searchParams.set('desc', '0');
  return u.toString();
}

async function fetchListingsParallel(templateUrl, dirs) {
  const accumulated = new Map(dirs.map(dir => [dir, []]));
  let pending = dirs.map(dir => ({ dir, pageNumber: 1 }));
  while (pending.length) {
    const requests = pending.map(job => ({ ...job, url: listingUrl(templateUrl, job.dir, job.pageNumber) }));
    let responses;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      responses = await page.evaluate(async values => Promise.all(values.map(async value => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
          const response = await fetch(value.url, { credentials: 'include', signal: controller.signal });
          return { ...value, ok: response.ok, status: response.status, body: await response.text() };
        } catch (error) {
          return { ...value, ok: false, status: 0, error: String(error), body: '' };
        } finally {
          clearTimeout(timeout);
        }
      })), requests);
      const failed = responses.filter(result => {
        if (!result.ok) return true;
        try { return Number(JSON.parse(result.body).errno || 0) !== 0; } catch { return true; }
      });
      if (!failed.length) break;
      lastError = failed[0];
      if (attempt < 2) await sleep(250 * attempt);
    }
    const failed = responses.filter(result => {
      if (!result.ok) return true;
      try { return Number(JSON.parse(result.body).errno || 0) !== 0; } catch { return true; }
    });
    if (failed.length) throw new Error(`并发目录接口失败: ${failed[0].dir}, HTTP ${failed[0].status}, ${lastError?.body?.slice(0, 120) || lastError?.error || ''}`);
    const next = [];
    for (const result of responses) {
      const list = JSON.parse(result.body).list || [];
      accumulated.get(result.dir).push(...list);
      if (list.length === 100) next.push({ dir: result.dir, pageNumber: result.pageNumber + 1 });
    }
    pending = next;
  }
  return accumulated;
}

async function scanSource(source) {
  try {
    await page.goto(source.url, { timeout: 30000 });
  } catch (error) {
    if (!String(error).includes('navigation committed')) throw error;
  }
  await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 20000 });
  const detected = await page.evaluate(() => {
    const locals = window.__DISK_SHARE_V2_LOCALS__ || {};
    let fileList = locals.file_list || [];
    try {
      const dumped = window.locals?.dump?.();
      fileList = dumped?.file_list?.value || dumped?.file_list || fileList;
    } catch {}
    if (fileList && !Array.isArray(fileList)) fileList = fileList.list || fileList.value || [];
    return (Array.isArray(fileList) ? fileList : []).map(item => ({
      name: item.server_filename || item.name || '', isDir: Number(item.isdir || item.is_dir || 0) === 1,
    })).filter(item => item.name);
  });
  if (!source.rootName) {
    const soleDirectory = detected.length === 1 && detected[0].isDir ? detected[0] : null;
    source.rootName = soleDirectory?.name || '';
    source.name = source.name || source.rootName || `百度分享 ${source.id}`;
  }
  if (source.rootName) {
    await page.waitForFunction(name => document.body.innerText.includes(name), source.rootName, { timeout: 20000 });
    const clicked = await page.evaluate(name => {
      const link = [...document.querySelectorAll('a')].find(node => node.textContent?.trim() === name);
      if (!link) return false;
      link.click();
      return true;
    }, source.rootName);
    if (!clicked) throw new Error(`未找到分享根目录链接: ${source.rootName}`);
  }
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(x => x.name.includes('/share/list?') && x.name.includes('sekey=')), undefined, { timeout: 20000 });
  const templateUrl = await page.evaluate(() => performance.getEntriesByType('resource').map(x => x.name).reverse().find(x => x.includes('/share/list?') && x.includes('sekey=')));
  if (!templateUrl) throw new Error('未发现百度分享目录接口');

  const rootPath = source.rootName ? `/${source.rootName}` : '/';
  const stateFile = `${stateDir}/source-${source.id}.json`;
  let savedState = null;
  try { savedState = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch {}
  const queue = savedState?.queue || [rootPath];
  const queued = new Set(queue);
  const visited = new Set(savedState?.visited || []);
  const itemMap = new Map((savedState?.items || []).map(item => [item.path, item]));
  let processedDirs = visited.size;
  let consecutiveBatchFailures = 0;
  let activeConcurrency = concurrency;
  const directoryFailures = new Map();
  async function saveState() {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ queue, visited: [...visited], items: [...itemMap.values()] }), 'utf8');
  }
  async function writeCheckpoint() {
    const items = [...itemMap.values()];
    const meta = {
      type: 'source', source_id: source.id, name: source.name, root_name: source.rootName,
      scanned_at: new Date().toISOString(), complete: false,
      processed_dirs: processedDirs, remaining_dirs: queue.length,
    };
    const filename = `${stateDir}/source-${source.id}-checkpoint-${processedDirs}.jsonl`;
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(filename, [JSON.stringify(meta), ...items.map(item => JSON.stringify(item))].join('\n') + '\n', 'utf8');
    console.log(JSON.stringify({ checkpoint: true, source: source.id, filename, processedDirs, queuedDirs: queue.length, items: items.length }));
  }
  async function scanDirectories(dirs) {
    const lists = await fetchListingsParallel(templateUrl, dirs);
    return dirs.map(dir => {
      const found = [];
      for (const raw of lists.get(dir)) {
        const isDir = Number(raw.isdir || 0) === 1;
        const itemPath = raw.path || `${dir}/${raw.server_filename}`.replaceAll('//', '/');
        found.push({
          type: 'item', source_id: source.id, fs_id: String(raw.fs_id || ''),
          path: itemPath, parent_path: parentOf(itemPath), name: raw.server_filename,
          is_dir: isDir, size: Number(raw.size || 0), server_mtime: raw.server_mtime || null,
          category: raw.category ?? null, md5: raw.md5 || null,
          extension: extensionOf(raw.server_filename || '', isDir),
          open_url: `${source.url}#list/path=${encodeURIComponent(isDir ? itemPath : parentOf(itemPath))}&vmode=list`
        });
      }
      return { dir, found };
    });
  }
  while (queue.length) {
    if (maxDirs && processedDirs >= maxDirs) break;
    const remaining = maxDirs ? Math.max(0, maxDirs - processedDirs) : activeConcurrency;
    const batchSize = Math.min(activeConcurrency, remaining || activeConcurrency);
    const batch = [];
    while (queue.length && batch.length < batchSize) {
      const dir = queue.shift();
      queued.delete(dir);
      if (!visited.has(dir)) batch.push(dir);
    }
    if (!batch.length) continue;
    let results;
    try {
      results = await scanDirectories(batch);
      consecutiveBatchFailures = 0;
      activeConcurrency = Math.min(concurrency, activeConcurrency + 4);
    } catch (error) {
      if (batch.length === 1) {
        const dir = batch[0];
        const failures = (directoryFailures.get(dir) || 0) + 1;
        directoryFailures.set(dir, failures);
        queue.push(dir);
        queued.add(dir);
        if (failures >= 8) throw new Error(`目录连续失败 8 次: ${dir}; ${error}`);
      } else {
        for (const dir of [...batch].reverse()) {
          queue.unshift(dir);
          queued.add(dir);
        }
      }
      activeConcurrency = Math.max(1, Math.floor(activeConcurrency / 2));
      consecutiveBatchFailures += 1;
      await saveState();
      console.log(JSON.stringify({ retrying: true, source: source.id, consecutiveBatchFailures, error: String(error) }));
      await sleep(Math.min(5000, consecutiveBatchFailures * 500));
      continue;
    }
    for (const { dir, found } of results) {
      visited.add(dir);
      processedDirs += 1;
      for (const item of found) {
        itemMap.set(item.path, item);
        if (item.is_dir && !visited.has(item.path) && !queued.has(item.path)) {
          queue.push(item.path);
          queued.add(item.path);
        }
      }
    }
    if (processedDirs % 40 < batch.length) {
      await saveState();
      console.log(JSON.stringify({ progress: true, source: source.id, processedDirs, queuedDirs: queue.length, items: itemMap.size, concurrency: activeConcurrency }));
    }
    if (processedDirs <= concurrency || processedDirs % 200 < batch.length) await writeCheckpoint();
  }
  const complete = queue.length === 0;
  const items = [...itemMap.values()];
  let emptyConfirmed = false;
  if (complete && items.length === 0) {
    await page.waitForTimeout(500);
    emptyConfirmed = await page.evaluate(() => /暂无文件|文件夹为空|空空如也|没有文件/.test(document.body?.innerText || ''));
  }
  const verifiedComplete = complete && (items.length > 0 || emptyConfirmed);
  const meta = {
    type: 'source', source_id: source.id, name: source.name, root_name: source.rootName,
    scanned_at: new Date().toISOString(), complete: verifiedComplete, empty_confirmed: emptyConfirmed,
    processed_dirs: processedDirs, remaining_dirs: queue.length,
    error: complete && !verifiedComplete ? 'empty_scan_unverified' : null,
  };
  const filename = `${projectRoot}/data/import/source-${source.id}.jsonl`;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, [JSON.stringify(meta), ...items.map(x => JSON.stringify(x))].join('\n') + '\n', 'utf8');
  if (verifiedComplete) await fs.rm(stateFile, { force: true });
  console.log(JSON.stringify({ exported: true, source: source.id, filename, complete: verifiedComplete, emptyConfirmed, processedDirs, items: items.length }));
}

for (const source of sources.filter(x => selectedIds.has(x.id))) {
  try { await scanSource(source); }
  catch (error) { console.log(JSON.stringify({ exported: false, source: source.id, error: String(error) })); }
}

if (globalThis.BAIDU_FINISH_TASK === true) await task.finish({ keep: [] });
