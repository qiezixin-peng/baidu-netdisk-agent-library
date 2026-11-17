// 由 ego-browser nodejs 运行：无需开放平台应用，按超限目录自适应拆分转存，再用登录态递归搜索快速建立近完整索引。
const fs = await import('node:fs/promises');
const path = await import('node:path');

const projectRoot = 'D:/三喜/Agent工具/百度网盘物料库';
const source = globalThis.BAIDU_FAST_SOURCE;
if (!source?.id || !source?.url) throw new Error('缺少 BAIDU_FAST_SOURCE');
const jobId = Number(globalThis.BAIDU_FAST_JOB_ID || Date.now());
const task = await taskSpace(globalThis.BAIDU_MATERIAL_SPACE_ID || 32);
const page = task.page(globalThis.BAIDU_SCAN_PAGE_LABEL || 'p6');
const tempRoot = `/Agent自动导入_快速搜索_${jobId}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const parentOf = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) || '/' : '/';
const extensionOf = (name, isDir) => isDir || !name.includes('.') ? '' : name.split('.').pop().toLowerCase().slice(0, 20);
let share = null;
let created = false;
let transferCalls = 0;
let skippedTransfers = 0;

async function navigateShare() {
  try { await page.goto(source.url, { timeout: 30000 }); }
  catch (error) { if (!String(error).includes('navigation committed')) throw error; }
  await page.waitForFunction(() => {
    const locals = window.__DISK_SHARE_V2_LOCALS__ || {};
    let files = locals.file_list || [];
    try { const dumped = window.locals?.dump?.(); files = dumped?.file_list?.value || dumped?.file_list || files; } catch {}
    if (!Array.isArray(files)) files = files?.list || files?.value || [];
    return Boolean(locals.shareid && locals.share_uk && locals.bdstoken && files.length);
  }, undefined, { timeout: 30000 });
  const context = await page.evaluate(() => {
    const locals = window.__DISK_SHARE_V2_LOCALS__ || {};
    let files = locals.file_list || [];
    try { const dumped = window.locals?.dump?.(); files = dumped?.file_list?.value || dumped?.file_list || files; } catch {}
    if (!Array.isArray(files)) files = files?.list || files?.value || [];
    const rawCookie = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('BDCLND='))?.slice(7) || '';
    return {
      shareid: String(locals.shareid || ''), shareUk: String(locals.share_uk || ''), bdstoken: String(locals.bdstoken || ''),
      sekey: String(locals.currentSekey || locals.sekey || (rawCookie ? decodeURIComponent(rawCookie) : '')),
      roots: files.map(item => ({ fs_id: String(item.fs_id || ''), name: item.server_filename || item.name || '',
        path: item.path || `/${item.server_filename || item.name || ''}`, is_dir: Number(item.isdir ?? item.is_dir ?? 0) === 1 })).filter(item => item.fs_id),
    };
  });
  const rootName = source.rootName || (context.roots.length === 1 && context.roots[0].is_dir ? context.roots[0].name : '');
  if (rootName) {
    const clicked = await page.evaluate(name => {
      const link = [...document.querySelectorAll('a')].find(node => node.textContent?.trim() === name);
      if (!link) return false;
      link.click();
      return true;
    }, rootName);
    if (!clicked) throw new Error(`未找到分享根目录链接: ${rootName}`);
  }
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(x => x.name.includes('/share/list?') && x.name.includes('sekey=')), undefined, { timeout: 20000 });
  context.templateUrl = await page.evaluate(() => performance.getEntriesByType('resource').map(x => x.name).reverse().find(x => x.includes('/share/list?') && x.includes('sekey=')) || '');
  context.rootName = rootName;
  return context;
}

async function createFolder(targetPath) {
  const data = await page.evaluate(async ({ targetPath, bdstoken }) => {
    const query = new URLSearchParams({ a: 'commit', channel: 'chunlei', bdstoken, app_id: '250528' });
    const body = new URLSearchParams({ path: targetPath, isdir: '1', size: '', block_list: '[]', method: 'post', dataType: 'json' });
    return (await fetch(`/api/create?${query}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json();
  }, { targetPath, bdstoken: share.bdstoken });
  if (![0, -8].includes(Number(data.errno || 0))) throw new Error(`创建隔离子目录失败 errno=${data.errno}: ${targetPath}`);
}

async function listDirectory(directory) {
  const all = [];
  for (let pageNumber = 1; pageNumber <= 5000; pageNumber += 1) {
    const url = new URL(share.templateUrl);
    url.searchParams.set('dir', directory);
    url.searchParams.set('page', String(pageNumber));
    url.searchParams.set('num', '100');
    url.searchParams.set('order', 'name');
    url.searchParams.set('desc', '0');
    const response = await page.fetch(url.toString(), { timeout: 30000 });
    const data = JSON.parse(response.body);
    if (!response.ok || Number(data.errno || 0) !== 0) throw new Error(`share/list errno=${data.errno ?? response.status}: ${directory}`);
    const list = Array.isArray(data.list) ? data.list : [];
    all.push(...list.map(item => ({ fs_id: String(item.fs_id || ''), name: item.server_filename || '', path: item.path || '', is_dir: Number(item.isdir ?? item.is_dir ?? 0) === 1 })));
    if (list.length < 100) break;
  }
  return all;
}

async function transferBatch(nodes, destination) {
  transferCalls += 1;
  if (transferCalls > 5000) throw new Error('自适应转存请求超过安全上限');
  let result;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(attempt === 1 ? 200 : attempt * 750);
    result = await page.evaluate(async ({ nodes, destination, share }) => {
      const query = new URLSearchParams({ shareid: share.shareid, from: share.shareUk, sekey: share.sekey, ondup: 'newcopy', async: '1' });
      const body = new URLSearchParams({ fsidlist: JSON.stringify(nodes.map(item => item.fs_id)), path: destination });
      return (await fetch(`/share/transfer?${query}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json();
    }, { nodes, destination, share });
    if (![4, -7].includes(Number(result.errno))) break;
    console.log(JSON.stringify({ fastTransferRetry: true, calls: transferCalls, attempt, errno: result.errno }));
  }
  if (Number(result.errno || 0) === 0) {
    console.log(JSON.stringify({ fastTransfer: true, calls: transferCalls, batch: nodes.length }));
    return;
  }
  if (Number(result.errno) !== 12) throw new Error(`转存失败 errno=${result.errno} ${result.show_msg || ''}`.trim());
  if (nodes.length > 1) {
    const middle = Math.ceil(nodes.length / 2);
    await transferBatch(nodes.slice(0, middle), destination);
    await transferBatch(nodes.slice(middle), destination);
    return;
  }
  const node = nodes[0];
  if (!node.is_dir) {
    skippedTransfers += 1;
    console.log(JSON.stringify({ fastTransferSkipped: true, skippedTransfers, errno: result.info?.[0]?.errno ?? result.errno }));
    return;
  }
  const childDestination = `${destination}/${node.name}`.replaceAll('//', '/');
  await createFolder(childDestination);
  const children = await listDirectory(node.path);
  if (!children.length) return;
  await transferBatch(children, childDestination);
}

async function recursiveSearch(keyword) {
  const found = new Map();
  let priorSignature = '';
  for (let pageNumber = 1; pageNumber <= 1000; pageNumber += 1) {
    const data = await page.evaluate(async ({ tempRoot, keyword, pageNumber }) => {
      const query = new URLSearchParams({ recursion: '1', key: keyword, page: String(pageNumber), num: '1000', dir: tempRoot, order: 'name', desc: '0' });
      const response = await fetch(`/api/search?${query}`, { credentials: 'include' });
      return response.json();
    }, { tempRoot, keyword, pageNumber });
    if (Number(data.errno || 0) !== 0) throw new Error(`递归搜索 errno=${data.errno}`);
    const list = Array.isArray(data.list) ? data.list : [];
    const signature = list.length ? `${list[0]?.fs_id}:${list.at(-1)?.fs_id}:${list.length}` : '';
    if (!list.length || signature === priorSignature) break;
    for (const item of list) found.set(String(item.fs_id || item.path), item);
    priorSignature = signature;
    console.log(JSON.stringify({ fastSearch: true, keyword, page: pageNumber, count: found.size }));
    if (list.length < 1000 && !Number(data.has_more ?? data.hasmore ?? 0)) break;
  }
  return [...found.values()];
}

async function cleanup() {
  return page.evaluate(async ({ tempRoot, bdstoken }) => {
    const query = new URLSearchParams({ opera: 'delete', async: '2', onnest: 'fail', channel: 'chunlei', web: '1', app_id: '250528', bdstoken });
    const body = new URLSearchParams({ filelist: JSON.stringify([tempRoot]) });
    return (await fetch(`/api/filemanager?${query}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json();
  }, { tempRoot, bdstoken: share.bdstoken });
}

try {
  share = await navigateShare();
  await createFolder(tempRoot);
  created = true;
  await transferBatch(share.roots, tempRoot);
  let files = [];
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    files = await recursiveSearch('.');
    if (files.length) break;
    await sleep(Math.min(5000, attempt * 500));
  }
  if (!files.length) throw new Error('快速递归搜索未返回文件');

  const items = new Map();
  for (const raw of files) {
    let itemPath = String(raw.path || '').startsWith(tempRoot) ? String(raw.path).slice(tempRoot.length) : String(raw.path || '');
    if (!itemPath.startsWith('/')) itemPath = `/${itemPath}`;
    const name = raw.server_filename || itemPath.slice(itemPath.lastIndexOf('/') + 1);
    const item = { type: 'item', source_id: source.id, fs_id: String(raw.fs_id || ''), path: itemPath, parent_path: parentOf(itemPath), name,
      is_dir: false, size: Number(raw.size || 0), server_mtime: raw.server_mtime || null, category: raw.category ?? null, md5: raw.md5 || null,
      extension: extensionOf(name, false), open_url: `${source.url}#list/path=${encodeURIComponent(parentOf(itemPath))}&vmode=list` };
    items.set(item.path, item);
    let directory = item.parent_path;
    while (directory && directory !== '/') {
      if (!items.has(directory)) items.set(directory, { type: 'item', source_id: source.id, fs_id: '', path: directory, parent_path: parentOf(directory),
        name: directory.slice(directory.lastIndexOf('/') + 1), is_dir: true, size: 0, extension: '', open_url: `${source.url}#list/path=${encodeURIComponent(directory)}&vmode=list` });
      directory = parentOf(directory);
    }
  }
  const filename = globalThis.BAIDU_FAST_OUTPUT || `${projectRoot}/data/import/source-${source.id}.jsonl`;
  const meta = { type: 'source', source_id: source.id, name: source.name || share.rootName, root_name: share.rootName,
    scanned_at: new Date().toISOString(), complete: false, provider: 'baidu_recursive_search', transfer_calls: transferCalls,
    coverage: 'files_with_extension_and_derived_directories', skipped_transfers: skippedTransfers };
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${[JSON.stringify(meta), ...items.values()].map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ fastSearchIndex: true, filename, files: files.length, items: items.size, transferCalls, skippedTransfers }));
} catch (error) {
  console.log(JSON.stringify({ fastSearchIndex: false, error: error.message, transferCalls }));
} finally {
  if (created && share) {
    try { const result = await cleanup(); console.log(JSON.stringify({ fastSearchCleanup: Number(result.errno || 0) === 0, errno: result.errno ?? 0 })); }
    catch (error) { console.log(JSON.stringify({ fastSearchCleanup: false, error: error.message })); }
  }
}
