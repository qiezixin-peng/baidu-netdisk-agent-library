// 由 ego-browser nodejs 运行。读取 archive-queue.json，递归索引压缩包目录，不下载压缩包。
const fs = await import('node:fs/promises');
const path = await import('node:path');

const projectRoot = 'D:/三喜/Agent工具/百度网盘物料库';
const queueFile = globalThis.BAIDU_ARCHIVE_QUEUE || `${projectRoot}/data/runtime/archive-queue.json`;
const queue = JSON.parse(await fs.readFile(queueFile, 'utf8'));
const selectedSources = new Set(globalThis.BAIDU_ARCHIVE_SOURCE_IDS || queue.archives.map(x => x.source_id));
const selectedItems = new Set(globalThis.BAIDU_ARCHIVE_ITEM_IDS || queue.archives.map(x => x.item_id));
const maxArchives = Number(globalThis.BAIDU_ARCHIVE_MAX || 0);
const task = await taskSpace(globalThis.BAIDU_MATERIAL_SPACE_ID || 'baidu-material-library-indexer');
const page = task.page(globalThis.BAIDU_ARCHIVE_PAGE_LABEL || 'p1');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const errorMessages = new Map([
  [116, '百度分享授权参数失效，需要重新打开分享'],
  [120, '当前百度账号没有在线浏览压缩包权限或登录态不可用'],
  [31180, '压缩包需要密码'], [31181, '压缩包内容数量过多'], [31182, '压缩包损坏'],
  [31183, '压缩包超过在线浏览限制'], [31193, '不支持固实压缩包'],
  [31194, '不支持分卷压缩包'], [31196, '暂不支持中文压缩密码']
]);

function normalizeInternal(parent, name) {
  const cleanParent = parent === '/' ? '' : parent.replace(/\/$/, '');
  return `${cleanParent}/${name}`.replace(/\/{2,}/g, '/');
}

function extensionOf(name, isDir) {
  if (isDir || !name.includes('.')) return '';
  return name.split('.').pop().toLowerCase().slice(0, 20);
}

async function getShareContext(source) {
  try {
    await page.goto(source.url, { timeout: 30000 });
  } catch (error) {
    if (!String(error).includes('navigation committed')) throw error;
  }
  await page.waitForFunction(name => document.body.innerText.includes(name), source.root_name, { timeout: 20000 });
  const clicked = await page.evaluate(name => {
    const link = [...document.querySelectorAll('a')].find(node => node.textContent?.trim() === name);
    if (!link) return false;
    link.click();
    return true;
  }, source.root_name);
  if (!clicked) throw new Error(`未找到分享根目录链接: ${source.root_name}`);
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(x => x.name.includes('/share/list?') && x.name.includes('sekey=')), undefined, { timeout: 20000 });
  const values = await page.evaluate(() => {
    const resource = performance.getEntriesByType('resource').map(x => x.name).reverse().find(x => x.includes('/share/list?') && x.includes('sekey=')) || '';
    const rawCookie = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('BDCLND='))?.slice(7) || '';
    return { resource, cookieSekey: rawCookie ? decodeURIComponent(rawCookie) : '' };
  });
  const resource = values.resource;
  if (!resource) throw new Error('未发现百度分享目录接口');
  const params = new URL(resource).searchParams;
  return {
    uk: params.get('uk') || '',
    shareid: params.get('shareid') || '',
    sekey: values.cookieSekey || params.get('sekey') || '',
    bdstoken: params.get('bdstoken') || ''
  };
}

async function requestArchiveList(item, share, subpath, start) {
  const params = new URLSearchParams({
    path: item.path, start: String(start), limit: '100', passwd: '', subpath,
    uk: share.uk, auth_type: '1', shareid: share.shareid, product: 'share',
    primaryid: share.shareid, fsid: String(item.fs_id), web: '1'
  });
  if (share.sekey) params.set('extra', JSON.stringify({ sekey: decodeURIComponent(share.sekey) }));
  if (share.bdstoken) params.set('bdstoken', share.bdstoken);
  const response = await page.fetch(`https://pan.baidu.com/api/zipfile/list?${params}`, { timeout: 30000 });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(response.body);
}

async function scanArchive(item, share) {
  const pending = ['/'];
  const visited = new Set();
  const entries = [];
  let taskRetries = 0;
  while (pending.length) {
    const subpath = pending.shift();
    if (visited.has(subpath)) continue;
    visited.add(subpath);
    for (let start = 0; ; start += 100) {
      const data = await requestArchiveList(item, share, subpath, start);
      if (Number(data.errno || 0) !== 0) {
        const error = new Error(errorMessages.get(Number(data.errno)) || `百度接口 errno=${data.errno}`);
        error.errno = Number(data.errno);
        throw error;
      }
      if (data.taskid && !Array.isArray(data.list)) {
        if (++taskRetries > 10) throw new Error('百度仍在准备压缩包目录，稍后可重试');
        await sleep(1500);
        start -= 100;
        continue;
      }
      const list = Array.isArray(data.list) ? data.list : [];
      for (const raw of list) {
        const name = raw.file_name || raw.server_filename || raw.name || '';
        if (!name) continue;
        const isDir = Number(raw.isdir || raw.is_dir || 0) === 1;
        const internalPath = normalizeInternal(subpath, name);
        entries.push({
          type: 'archive_entry', item_id: item.item_id, internal_path: internalPath,
          parent_internal_path: subpath, name, is_dir: isDir, size: Number(raw.size || 0),
          extension: extensionOf(name, isDir), crc32: raw.crc32 || raw.crc || null
        });
        if (isDir) pending.push(internalPath);
      }
      const total = Number(data.total ?? list.length);
      if (list.length < 100 || start + list.length >= total) break;
      await sleep(100);
    }
    await sleep(100);
  }
  return entries;
}

async function writeResult(item, meta, entries = []) {
  const filename = `${projectRoot}/data/import/archive-${item.item_id}.jsonl`;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, [JSON.stringify({
    type: 'archive', item_id: item.item_id, provider: 'baidu_zipfile', replace_entries: meta.status === 'complete',
    scanned_at: new Date().toISOString(), entry_count: entries.length, ...meta
  }), ...entries.map(value => JSON.stringify(value))].join('\n') + '\n', 'utf8');
  return filename;
}

const archives = queue.archives
  .filter(item => selectedSources.has(item.source_id) && selectedItems.has(item.item_id))
  .slice(0, maxArchives || undefined);
for (const sourceId of [...new Set(archives.map(item => item.source_id))]) {
  const sourceItems = archives.filter(item => item.source_id === sourceId);
  const source = sourceItems[0];
  let share;
  try {
    share = await getShareContext(source);
  } catch (error) {
    for (const item of sourceItems) {
      const filename = await writeResult(item, { status: 'error', message: String(error) });
      console.log(JSON.stringify({ indexed: false, item: item.item_id, filename, error: String(error) }));
    }
    continue;
  }
  for (const item of sourceItems) {
    try {
      const entries = await scanArchive(item, share);
      const filename = await writeResult(item, { status: 'complete' }, entries);
      console.log(JSON.stringify({ indexed: true, item: item.item_id, entries: entries.length, filename }));
    } catch (error) {
      const status = error.errno === 120 ? 'blocked_membership' : error.errno === 31180 ? 'blocked_password' : 'error';
      const filename = await writeResult(item, { status, errno: error.errno ?? null, message: error.message });
      console.log(JSON.stringify({ indexed: false, item: item.item_id, status, filename, error: error.message }));
    }
    await sleep(150);
  }
}

if (globalThis.BAIDU_FINISH_TASK === true) await task.finish({ keep: [] });
