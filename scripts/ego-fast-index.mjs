// 由 ego-browser nodejs 运行：分享内容服务端转存后，通过官方 listall 一次递归导出。
const fs = await import('node:fs/promises');
const path = await import('node:path');
const { getAccessToken, listAllRecursive, mapListAllRecord, readOpenConfig } = await import('file:///D:/三喜/Agent工具/百度网盘物料库/src/baidu-open-api.mjs');

const projectRoot = 'D:/三喜/Agent工具/百度网盘物料库';
const source = globalThis.BAIDU_FAST_SOURCE;
if (!source?.id || !source?.url) throw new Error('缺少 BAIDU_FAST_SOURCE');
const jobId = Number(globalThis.BAIDU_FAST_JOB_ID || Date.now());
const task = await taskSpace(globalThis.BAIDU_MATERIAL_SPACE_ID || 32);
const page = task.page(globalThis.BAIDU_SCAN_PAGE_LABEL || 'p6');
const config = readOpenConfig();
const accessToken = await getAccessToken();
if (!accessToken || !config.appName) {
  console.log(JSON.stringify({ fastIndex: false, reason: 'open_api_not_authorized' }));
} else {
  const safeAppName = config.appName.replaceAll('/', '').trim();
  const tempRoot = `/apps/${safeAppName}/Agent自动导入_${jobId}`;
  let created = false;

  async function navigateShare() {
    try { await page.goto(source.url, { timeout: 30000 }); }
    catch (error) { if (!String(error).includes('navigation committed')) throw error; }
    await page.waitForFunction(() => {
      const locals = window.__DISK_SHARE_V2_LOCALS__ || {};
      let files = locals.file_list || [];
      try {
        const dumped = window.locals?.dump?.();
        files = dumped?.file_list?.value || dumped?.file_list || files;
      } catch {}
      if (!Array.isArray(files)) files = files?.list || files?.value || [];
      return Boolean(locals.shareid && locals.share_uk && locals.bdstoken && Array.isArray(files) && files.length);
    }, undefined, { timeout: 30000 });
    return page.evaluate(() => {
      const locals = window.__DISK_SHARE_V2_LOCALS__ || {};
      let files = locals.file_list || [];
      try {
        const dumped = window.locals?.dump?.();
        files = dumped?.file_list?.value || dumped?.file_list || files;
      } catch {}
      if (!Array.isArray(files)) files = files?.list || files?.value || [];
      const rawCookie = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('BDCLND='))?.slice(7) || '';
      return {
        shareid: String(locals.shareid || ''), shareUk: String(locals.share_uk || ''),
        bdstoken: String(locals.bdstoken || ''),
        sekey: String(locals.currentSekey || locals.sekey || (rawCookie ? decodeURIComponent(rawCookie) : '')),
        files: files.map(item => ({
          fs_id: String(item.fs_id || ''), name: item.server_filename || item.name || '',
          is_dir: Number(item.isdir ?? item.isdir ?? item.is_dir ?? 0) === 1,
        })).filter(item => item.fs_id),
      };
    });
  }

  async function createFolder(targetPath, bdstoken) {
    return page.evaluate(async ({ targetPath, bdstoken }) => {
      const query = new URLSearchParams({ a: 'commit', channel: 'chunlei', bdstoken, app_id: '250528' });
      const body = new URLSearchParams({ path: targetPath, isdir: '1', size: '', block_list: '[]', method: 'post', dataType: 'json' });
      const response = await fetch(`/api/create?${query}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      return response.json();
    }, { targetPath, bdstoken });
  }

  async function transferRoot(files, share) {
    return page.evaluate(async ({ files, share, tempRoot }) => {
      const query = new URLSearchParams({
        shareid: share.shareid, from: share.shareUk, sekey: share.sekey, ondup: 'newcopy', async: '1',
      });
      const body = new URLSearchParams({ fsidlist: JSON.stringify(files.map(item => item.fs_id)), path: tempRoot });
      const response = await fetch(`/share/transfer?${query}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      return response.json();
    }, { files, share, tempRoot });
  }

  async function removeTemp(share) {
    return page.evaluate(async ({ tempRoot, bdstoken }) => {
      const query = new URLSearchParams({ opera: 'delete', async: '2', onnest: 'fail', channel: 'chunlei', web: '1', app_id: '250528', bdstoken });
      const body = new URLSearchParams({ filelist: JSON.stringify([tempRoot]) });
      const response = await fetch(`/api/filemanager?${query}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      return response.json();
    }, { tempRoot, bdstoken: share.bdstoken });
  }

  let share;
  try {
    share = await navigateShare();
    const soleRoot = share.files.length === 1 && share.files[0].is_dir ? share.files[0].name : '';
    const rootName = source.rootName || soleRoot;
    const createdFolder = await createFolder(tempRoot, share.bdstoken);
    if (![0, -8].includes(Number(createdFolder.errno || 0))) throw new Error(`创建隔离目录失败 errno=${createdFolder.errno}`);
    created = true;
    const transferred = await transferRoot(share.files, share);
    if (Number(transferred.errno || 0) !== 0) throw new Error(`转存失败 errno=${transferred.errno} ${transferred.show_msg || ''}`.trim());

    let result;
    let lastError;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        const preferredLimits = attempt <= 4 ? [10_000] : attempt <= 8 ? [5_000] : [1_000];
        result = await listAllRecursive({ accessToken, directory: tempRoot, limit: preferredLimits[0],
          onPage: progress => console.log(JSON.stringify({ fastProgress: true, limit: preferredLimits[0], ...progress })) });
        if (result.records.length) break;
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, attempt * 500)));
    }
    if (!result?.records?.length) throw lastError || new Error('转存完成后 listall 暂无数据');
    const items = result.records.map(raw => mapListAllRecord(raw, {
      sourceId: source.id, tempRoot, sourceUrl: source.url,
    })).filter(item => item.path !== '/');
    const filename = `${projectRoot}/data/import/source-${source.id}.jsonl`;
    const meta = {
      type: 'source', source_id: source.id, name: source.name || rootName || `百度分享 ${source.id}`,
      root_name: rootName, scanned_at: new Date().toISOString(), complete: true,
      provider: 'baidu_open_listall', pages: result.pages,
    };
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, `${[JSON.stringify(meta), ...items.map(item => JSON.stringify(item))].join('\n')}\n`, 'utf8');
    console.log(JSON.stringify({ fastIndex: true, exported: true, filename, items: items.length, pages: result.pages }));
  } catch (error) {
    const message = String(error.message || error);
    const needsSvip = /转存失败 errno=12\b/.test(message) || /转存数量|会员|SVIP/i.test(message);
    console.log(JSON.stringify({
      fastIndex: false,
      reason: needsSvip ? 'svip_transfer_required' : 'fast_index_failed',
      needsUserAction: needsSvip ? 'scan_svip_qr' : undefined,
      error: message,
    }));
  } finally {
    if (created && share) {
      try {
        const cleanup = await removeTemp(share);
        console.log(JSON.stringify({ fastCleanup: Number(cleanup.errno || 0) === 0, errno: cleanup.errno ?? 0 }));
      } catch (error) {
        console.log(JSON.stringify({ fastCleanup: false, error: error.message }));
      }
    }
  }
}
