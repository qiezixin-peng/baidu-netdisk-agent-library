// 由 ego-browser nodejs 运行。临时转存 ZIP 后仅用 HTTP Range 读取中央目录，不下载整包。
const fs = await import('node:fs/promises');
const path = await import('node:path');
const { HttpRangeReader, ZipReader } = await import('file:///D:/三喜/Agent工具/百度网盘物料库/node_modules/@zip.js/zip.js/index.js');
const { walkRar3Archive, walkRar5Archive } = await import('file:///D:/三喜/Agent工具/百度网盘物料库/node_modules/@mary/rar/lib/mod.js');

const projectRoot = 'D:/三喜/Agent工具/百度网盘物料库';
const queueFile = globalThis.BAIDU_ARCHIVE_QUEUE || `${projectRoot}/data/runtime/archive-queue.json`;
const queue = JSON.parse(await fs.readFile(queueFile, 'utf8'));
const selectedSources = new Set(globalThis.BAIDU_ARCHIVE_SOURCE_IDS || queue.archives.map(value => value.source_id));
const selectedItems = new Set(globalThis.BAIDU_ARCHIVE_ITEM_IDS || queue.archives.map(value => value.item_id));
const maxArchives = Number(globalThis.BAIDU_ARCHIVE_MAX || 0);
const batchSize = Math.max(1, Math.min(50, Number(globalThis.BAIDU_ARCHIVE_BATCH_SIZE || 24)));
const concurrency = Math.max(1, Math.min(16, Number(globalThis.BAIDU_ARCHIVE_CONCURRENCY || 12)));
const tempRoot = globalThis.BAIDU_ARCHIVE_TEMP_ROOT || '/Agent压缩包索引临时_20261113';
const task = await taskSpace(globalThis.BAIDU_MATERIAL_SPACE_ID || 32);
const page = task.page(globalThis.BAIDU_ARCHIVE_PAGE_LABEL || 'p6');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function extensionOf(name, isDir) {
  if (isDir || !name.includes('.')) return '';
  return name.split('.').pop().toLowerCase().slice(0, 20);
}

function normalizeEntry(filename, directory) {
  const clean = String(filename || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return null;
  const internalPath = `/${clean}`;
  const separator = internalPath.lastIndexOf('/');
  return {
    internalPath,
    parentPath: separator <= 0 ? '/' : internalPath.slice(0, separator),
    name: internalPath.slice(separator + 1),
    isDir: Boolean(directory),
  };
}

async function writeResult(item, meta, entries = []) {
  const filename = `${projectRoot}/data/import/archive-${item.item_id}.jsonl`;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const records = [JSON.stringify({
    type: 'archive',
    item_id: item.item_id,
    provider: `baidu_transfer_${item.extension}_range`,
    replace_entries: meta.status === 'complete',
    scanned_at: new Date().toISOString(),
    entry_count: entries.length,
    ...meta,
  })];
  for (const entry of entries) records.push(JSON.stringify(entry));
  await fs.writeFile(filename, `${records.join('\n')}\n`, 'utf8');
  return filename;
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
  await page.waitForFunction(() => {
    const locals = window.__DISK_SHARE_V2_LOCALS__ || {};
    return Boolean(locals.shareid && locals.share_uk && locals.bdstoken);
  }, undefined, { timeout: 20000 });
  return page.evaluate(() => {
    const locals = window.__DISK_SHARE_V2_LOCALS__ || {};
    const rawCookie = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('BDCLND='))?.slice(7) || '';
    return {
      shareid: String(locals.shareid || ''),
      shareUk: String(locals.share_uk || ''),
      sekey: String(locals.currentSekey || locals.sekey || (rawCookie ? decodeURIComponent(rawCookie) : '')),
      bdstoken: String(locals.bdstoken || ''),
    };
  });
}

async function ensureTempFolder(share) {
  return page.evaluate(async ({ tempRoot, bdstoken }) => {
    const query = new URLSearchParams({ a: 'commit', channel: 'chunlei', bdstoken, app_id: '250528' });
    const body = new URLSearchParams({ path: tempRoot, isdir: '1', size: '', block_list: '[]', method: 'post', dataType: 'json' });
    const response = await fetch(`/api/create?${query}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    return response.json();
  }, { tempRoot, bdstoken: share.bdstoken });
}

async function transferBatch(items, share) {
  return page.evaluate(async ({ items, share, tempRoot }) => {
    const query = new URLSearchParams({
      shareid: share.shareid,
      from: share.shareUk,
      sekey: share.sekey,
      ondup: 'newcopy',
      async: '1',
    });
    const body = new URLSearchParams({
      fsidlist: JSON.stringify(items.map(item => String(item.fs_id))),
      path: tempRoot,
    });
    const response = await fetch(`/share/transfer?${query}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    return response.json();
  }, { items, share, tempRoot });
}

async function getCookieHeader() {
  const cookies = (await page.cdp('Network.getAllCookies')).cookies;
  return cookies
    .filter(cookie => cookie.domain.endsWith('baidu.com'))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function getMetadata(paths, cookieHeader) {
  const groups = await mapLimit(paths, concurrency, async targetPath => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const url = new URL('https://pan.baidu.com/api/filemetas');
        url.searchParams.set('target', JSON.stringify([targetPath]));
        url.searchParams.set('dlink', '1');
        const response = await fetch(url, {
          headers: { cookie: cookieHeader, referer: 'https://pan.baidu.com/disk/main', 'user-agent': 'netdisk' },
        });
        const data = await response.json();
        if (Number(data.errno) === 0) {
          return Array.isArray(data.info) ? data.info : Array.isArray(data.list) ? data.list : [];
        }
        lastError = new Error(`filemetas errno=${data.errno}`);
      } catch (error) {
        lastError = error;
      }
      await sleep(attempt * 500);
    }
    console.log(JSON.stringify({ metadata: false, path: targetPath, error: lastError?.message || 'unknown' }));
    return [];
  });
  return groups.flat();
}

async function scanZip(item, dlink, cookieHeader) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('ZIP Range 请求超过 15 秒')), 15000);
  const reader = new ZipReader(new HttpRangeReader(dlink, {
    headers: new Map([['User-Agent', 'netdisk'], ['Cookie', cookieHeader]]),
    checkResourceChanges: false,
    maximumRangeSize: 1024 * 1024,
    signal: controller.signal,
  }));
  try {
    const rawEntries = await reader.getEntries();
    const entries = [];
    for (const raw of rawEntries) {
      const normalized = normalizeEntry(raw.filename, raw.directory);
      if (!normalized) continue;
      entries.push({
        type: 'archive_entry',
        item_id: item.item_id,
        internal_path: normalized.internalPath,
        parent_internal_path: normalized.parentPath,
        name: normalized.name,
        is_dir: normalized.isDir,
        size: Number(raw.uncompressedSize || 0),
        extension: extensionOf(normalized.name, normalized.isDir),
        crc32: raw.signature == null ? null : String(raw.signature),
      });
    }
    return entries;
  } finally {
    clearTimeout(timeout);
    await reader.close().catch(() => {});
  }
}

async function scanRar(item, dlink, cookieHeader) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('RAR Range 请求超过 90 秒')), 90000);
  const authenticatedFetch = (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('User-Agent', 'netdisk');
    headers.set('Cookie', cookieHeader);
    return fetch(input, { ...init, headers, signal: controller.signal, redirect: 'follow' });
  };
  try {
    const probe = await authenticatedFetch(dlink, { headers: { Range: 'bytes=0-0' } });
    if (probe.status !== 206) throw new Error(`RAR Range 探测 HTTP ${probe.status}`);
    const match = /\/(\d+)\s*$/.exec(probe.headers.get('content-range') || '');
    await probe.body?.cancel();
    if (!match) throw new Error('RAR Range 探测缺少总长度');
    let cacheStart = -1;
    let cacheBytes = new Uint8Array();
    const reader = {
      length: Number(match[1]),
      async read(offset, length) {
        const requestedLength = length === undefined ? this.length - offset : length;
        const cacheEnd = cacheStart + cacheBytes.length;
        if (!(cacheStart >= 0 && offset >= cacheStart && offset + requestedLength <= cacheEnd)) {
          const fetchLength = Math.max(requestedLength, Math.min(64 * 1024, this.length - offset));
          const end = offset + fetchLength - 1;
          const response = await authenticatedFetch(dlink, { headers: { Range: `bytes=${offset}-${end}` } });
          if (response.status !== 206) {
            throw new Error(`RAR Range 读取 HTTP ${response.status}`);
          }
          cacheStart = offset;
          cacheBytes = new Uint8Array(await response.arrayBuffer());
        }
        const relative = offset - cacheStart;
        const slice = cacheBytes.slice(relative, relative + requestedLength);
        if (slice.length !== requestedLength) {
          throw new Error(`RAR Range 返回长度不足 ${slice.length}/${requestedLength}`);
        }
        return new Blob([slice]).stream();
      },
    };
    const signatureStream = await reader.read(0, Math.min(8, reader.length));
    const signature = new Uint8Array(await new Response(signatureStream).arrayBuffer());
    const isRar5 = signature.length >= 8 && signature[6] === 1 && signature[7] === 0;
    const walker = isRar5 ? walkRar5Archive(reader) : walkRar3Archive(reader);
    const entries = [];
    for await (const { block } of walker) {
      if (block.kind !== 'file') continue;
      const name = block.name;
      const isDir = isRar5 ? name.endsWith('/') : (block.fileFlags & 0x00e0) === 0x00e0;
      const normalized = normalizeEntry(name, isDir);
      if (!normalized) continue;
      entries.push({
        type: 'archive_entry',
        item_id: item.item_id,
        internal_path: normalized.internalPath,
        parent_internal_path: normalized.parentPath,
        name: normalized.name,
        is_dir: normalized.isDir,
        size: Number(block.unpackedSize || 0),
        extension: extensionOf(normalized.name, normalized.isDir),
        crc32: block.crc == null ? null : String(block.crc),
      });
    }
    return entries;
  } finally {
    clearTimeout(timeout);
  }
}

function scanArchive(item, dlink, cookieHeader) {
  return item.extension === 'rar'
    ? scanRar(item, dlink, cookieHeader)
    : scanZip(item, dlink, cookieHeader);
}

async function deleteTransferred(paths, share) {
  if (!paths.length) return { errno: 0 };
  return page.evaluate(async ({ paths, bdstoken }) => {
    const query = new URLSearchParams({
      opera: 'delete', async: '2', onnest: 'fail', channel: 'chunlei', web: '1', app_id: '250528', bdstoken,
    });
    const body = new URLSearchParams({ filelist: JSON.stringify(paths) });
    const response = await fetch(`/api/filemanager?${query}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    return response.json();
  }, { paths, bdstoken: share.bdstoken });
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let next = 0;
  async function run() {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

async function isAlreadyComplete(item) {
  if (globalThis.BAIDU_ARCHIVE_FORCE === true) return false;
  try {
    const content = await fs.readFile(`${projectRoot}/data/import/archive-${item.item_id}.jsonl`, 'utf8');
    const firstLine = content.split(/\r?\n/, 1)[0];
    const meta = JSON.parse(firstLine);
    return meta.status === 'complete' && meta.provider === `baidu_transfer_${item.extension}_range`;
  } catch {
    return false;
  }
}

let archives = queue.archives.filter(item =>
  ['zip', 'rar'].includes(item.extension) && selectedSources.has(item.source_id) && selectedItems.has(item.item_id));
const pendingArchives = [];
for (const item of archives) if (!(await isAlreadyComplete(item))) pendingArchives.push(item);
archives = pendingArchives;
if (maxArchives) archives = archives.slice(0, maxArchives);

let lastShare = null;
for (const sourceId of [...new Set(archives.map(item => item.source_id))]) {
  const sourceItems = archives.filter(item => item.source_id === sourceId);
  const source = sourceItems[0];
  let share;
  try {
    share = await getShareContext(source);
    lastShare = share;
    const folder = await ensureTempFolder(share);
    if (![0, -8].includes(Number(folder.errno))) throw new Error(`创建临时目录失败 errno=${folder.errno}`);
  } catch (error) {
    for (const item of sourceItems) await writeResult(item, { status: 'error', message: String(error) });
    console.log(JSON.stringify({ sourceId, ok: false, stage: 'context', error: String(error) }));
    continue;
  }

  for (let offset = 0; offset < sourceItems.length; offset += batchSize) {
    const batch = sourceItems.slice(offset, offset + batchSize);
    let transferredPaths = [];
    try {
      const transfer = await transferBatch(batch, share);
      if (Number(transfer.errno) !== 0) throw new Error(`transfer errno=${transfer.errno} ${transfer.show_msg || ''}`.trim());
      const transferred = Array.isArray(transfer.extra?.list) ? transfer.extra.list : [];
      const byFromFsId = new Map(transferred.map(entry => [String(entry.from_fs_id), entry]));
      transferredPaths = transferred.map(entry => entry.to).filter(Boolean);
      const cookieHeader = await getCookieHeader();
      const metadata = await getMetadata(transferredPaths, cookieHeader);
      const byPath = new Map(metadata.map(entry => [entry.path, entry]));
      await mapLimit(batch, concurrency, async item => {
        const moved = byFromFsId.get(String(item.fs_id));
        const meta = moved ? byPath.get(moved.to) : null;
        if (!moved || !meta?.dlink) {
          const filename = await writeResult(item, { status: 'error', message: '临时转存后未取得 dlink' });
          console.log(JSON.stringify({ indexed: false, item: item.item_id, filename, error: 'missing_dlink' }));
          return;
        }
        try {
          const entries = await scanArchive(item, meta.dlink, cookieHeader);
          const filename = await writeResult(item, { status: 'complete' }, entries);
          console.log(JSON.stringify({ indexed: true, item: item.item_id, entries: entries.length, filename }));
        } catch (error) {
          const filename = await writeResult(item, { status: 'error', message: error.message });
          console.log(JSON.stringify({ indexed: false, item: item.item_id, filename, error: error.message }));
        }
      });
    } catch (error) {
      for (const item of batch) await writeResult(item, { status: 'error', message: error.message });
      console.log(JSON.stringify({ sourceId, offset, ok: false, stage: 'batch', error: error.message }));
    } finally {
      if (transferredPaths.length) {
        try {
          const deleted = await deleteTransferred(transferredPaths, share);
          console.log(JSON.stringify({ cleanup: true, sourceId, offset, count: transferredPaths.length, errno: deleted.errno }));
        } catch (error) {
          console.log(JSON.stringify({ cleanup: false, sourceId, offset, count: transferredPaths.length, error: error.message }));
        }
      }
    }
    await sleep(250);
  }
}

if (lastShare) {
  try {
    const deleted = await deleteTransferred([tempRoot], lastShare);
    console.log(JSON.stringify({ cleanupRoot: true, path: tempRoot, errno: deleted.errno }));
  } catch (error) {
    console.log(JSON.stringify({ cleanupRoot: false, path: tempRoot, error: error.message }));
  }
}

if (globalThis.BAIDU_FINISH_TASK === true) await task.finish({ keep: [] });
