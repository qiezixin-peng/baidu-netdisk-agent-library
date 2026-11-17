const state = {
  source: 0,
  sources: [],
  selectedItems: new Set(JSON.parse(localStorage.getItem('selectedItems') || '[]')),
  selectedEntries: new Set(JSON.parse(localStorage.getItem('selectedEntries') || '[]')),
};
const $ = selector => document.querySelector(selector);

const formatSize = bytes => {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]));

const iconFor = item => ({ folder: '▰', archive: 'ZIP', archive_entry: '↳', audio: '♪', video: '▶', image: '▧', document: 'DOC', other: '·' }[item.type] || '·');

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.message || response.statusText);
  return data;
}

function renderStats(status) {
  const scanned = status.sources.filter(source => source.scan_status === 'complete').length;
  $('#stats').innerHTML = `
    <article><span>来源</span><strong>${status.sources.length}</strong></article>
    <article><span>已索引项目</span><strong>${Number(status.item_count || 0).toLocaleString()}</strong></article>
    <article><span>包内条目</span><strong>${Number(status.archive_entry_count || 0).toLocaleString()}</strong></article>
    <article><span>完整来源</span><strong>${scanned}/${status.sources.length}</strong></article>`;
}

function renderSources(sources) {
  state.sources = sources;
  $('#sourceCount').textContent = `${sources.length} 个`;
  $('#sources').innerHTML = `<button class="source active" data-source="0"><span>全部来源</span><small>统一搜索</small></button>` +
    sources.map(source => `<button class="source" data-source="${source.id}">
      <span>${source.id}. ${escapeHtml(source.name)}</span>
      <small>${Number(source.item_count || 0).toLocaleString()} 项 · ${source.scan_status === 'complete' ? '已完成' : source.scan_status === 'partial' ? '部分索引' : '等待 Agent'}</small>
    </button>`).join('');
  document.querySelectorAll('.source').forEach(button => button.addEventListener('click', () => selectSource(Number(button.dataset.source))));
}

function isSelected(item) {
  return item.kind === 'archive_entry' ? state.selectedEntries.has(item.id) : state.selectedItems.has(item.id);
}

function updateSelectionBar() {
  const count = state.selectedItems.size + state.selectedEntries.size;
  $('#selectionCount').textContent = String(count);
  $('#selectionBar').classList.toggle('hidden', count === 0);
  localStorage.setItem('selectedItems', JSON.stringify([...state.selectedItems]));
  localStorage.setItem('selectedEntries', JSON.stringify([...state.selectedEntries]));
}

function renderItems(items, total = items.length) {
  $('#resultCount').textContent = `${Number(total).toLocaleString()} 项`;
  $('#empty').classList.toggle('hidden', items.length > 0);
  $('#empty').innerHTML = '<strong>没有找到匹配项目</strong><p>可以换一个关键词或文件类型。</p>';
  $('#results').innerHTML = items.map(item => {
    const kind = item.kind || 'item';
    const archiveEntry = kind === 'archive_entry';
    return `<article class="item ${item.is_dir ? 'directory' : ''}" data-kind="${kind}" data-id="${item.id}">
      <label class="select-box" title="加入下载清单"><input type="checkbox" ${isSelected({ ...item, kind }) ? 'checked' : ''}></label>
      <div class="file-icon ${item.type}">${iconFor(item)}</div>
      <div class="item-main">
        <h3 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3>
        <p>${archiveEntry ? `位于 ${escapeHtml(item.archive_name)} · ${escapeHtml(item.internal_path)}` : `${escapeHtml(item.source_name || '')} · ${escapeHtml(item.parent_path)}`}</p>
      </div>
      <span class="meta">${item.is_dir ? '文件夹' : formatSize(item.size)}</span>
      <button class="preview-action quiet">预览</button>
      ${archiveEntry ? '' : `<a class="open" href="/api/open/${item.id}" target="_blank" rel="noopener">在网盘查看</a>`}
    </article>`;
  }).join('');
  document.querySelectorAll('.item').forEach(row => {
    const kind = row.dataset.kind;
    const id = Number(row.dataset.id);
    row.querySelector('input').addEventListener('change', event => {
      const target = kind === 'archive_entry' ? state.selectedEntries : state.selectedItems;
      event.target.checked ? target.add(id) : target.delete(id);
      updateSelectionBar();
    });
    row.querySelector('.preview-action').addEventListener('click', () => kind === 'archive_entry' ? previewArchiveEntry(id, row) : previewItem(id));
  });
}

function combinedResults(data) {
  return [
    ...data.items.map(item => ({ ...item, kind: 'item' })),
    ...data.archiveEntries.map(entry => ({ ...entry, kind: 'archive_entry', type: entry.is_dir ? 'folder' : 'archive_entry' })),
  ];
}

async function selectSource(id) {
  state.source = id;
  document.querySelectorAll('.source').forEach(element => element.classList.toggle('active', Number(element.dataset.source) === id));
  $('#searchInput').value = '';
  $('#typeFilter').value = '';
  const source = state.sources.find(entry => entry.id === id);
  $('#resultMode').textContent = id ? '来源目录' : '目录';
  $('#resultTitle').textContent = source ? source.name : '全部来源';
  const data = await api(`/api/search?limit=100${id ? `&source=${id}` : ''}`);
  renderItems(combinedResults(data), data.total + data.archiveEntryTotal);
}

async function search() {
  const q = $('#searchInput').value.trim();
  const type = $('#typeFilter').value;
  const params = new URLSearchParams({ q, type, limit: '200' });
  if ($('#includeSystem').checked) params.set('includeSystem', '1');
  if (state.source) params.set('source', state.source);
  const data = await api(`/api/search?${params}`);
  $('#resultMode').textContent = q ? '搜索结果（含压缩包内部）' : '目录';
  $('#resultTitle').textContent = q ? `“${q}”` : (state.sources.find(source => source.id === state.source)?.name || '全部来源');
  renderItems(combinedResults(data), data.total + data.archiveEntryTotal);
}

function showPreview(html) {
  $('#previewContent').innerHTML = html;
  $('#previewDrawer').classList.remove('hidden');
}

async function previewItem(id) {
  const data = await api(`/api/preview/${id}`);
  const item = data.item;
  const archiveList = data.archiveEntries.length ? `<div class="archive-preview"><h3>压缩包内部（根目录）</h3>${data.archiveEntries.map(entry => `
    <button class="archive-line" data-entry="${entry.id}" data-dir="${entry.is_dir ? '1' : '0'}" data-path="${escapeHtml(entry.internal_path)}"><span>${entry.is_dir ? '▰' : '↳'} ${escapeHtml(entry.name)}</span><small>${formatSize(entry.size)}</small></button>`).join('')}</div>` : '';
  showPreview(`<p class="eyebrow">${escapeHtml(item.type)}</p><h2>${escapeHtml(item.name)}</h2>
    <dl><dt>来源</dt><dd>${escapeHtml(item.source_name)}</dd><dt>路径</dt><dd>${escapeHtml(item.path)}</dd><dt>大小</dt><dd>${formatSize(item.size)}</dd></dl>
    ${item.archive_status ? `<p class="preview-status">压缩包索引：${escapeHtml(item.archive_status)} · ${Number(item.archive_entry_count || 0)} 项</p>` : ''}
    ${archiveList}<div class="drawer-actions"><button id="selectPreviewItem" class="primary">加入下载清单</button><a class="open" href="/api/open/${item.id}" target="_blank">在百度网盘查看</a></div>`);
  $('#selectPreviewItem').addEventListener('click', () => { state.selectedItems.add(item.id); updateSelectionBar(); });
  document.querySelectorAll('.archive-line').forEach(button => button.addEventListener('click', () => button.dataset.dir === '1'
    ? browseArchive(item.id, button.dataset.path)
    : previewArchiveEntry(Number(button.dataset.entry), button)));
}

async function browseArchive(itemId, internalPath) {
  const data = await api(`/api/archive?${new URLSearchParams({ item: String(itemId), path: internalPath })}`);
  showPreview(`<p class="eyebrow">压缩包目录</p><h2>${escapeHtml(data.archive.name)}</h2><p class="preview-status">${escapeHtml(internalPath)}</p>
    <div class="archive-preview">${data.entries.map(entry => `<button class="archive-line" data-entry="${entry.id}" data-dir="${entry.is_dir ? '1' : '0'}" data-path="${escapeHtml(entry.internal_path)}"><span>${entry.is_dir ? '▰' : '↳'} ${escapeHtml(entry.name)}</span><small>${formatSize(entry.size)}</small></button>`).join('')}</div>`);
  document.querySelectorAll('.archive-line').forEach(button => button.addEventListener('click', () => button.dataset.dir === '1'
    ? browseArchive(itemId, button.dataset.path)
    : previewArchiveEntry(Number(button.dataset.entry), button)));
}

async function previewArchiveEntry(id) {
  const data = await api(`/api/archive-entry/${id}`);
  const entry = data.entry;
  showPreview(`<p class="eyebrow">压缩包内部条目</p><h2>${escapeHtml(entry.name)}</h2>
    <dl><dt>来源</dt><dd>${escapeHtml(entry.source_name)}</dd><dt>压缩包</dt><dd>${escapeHtml(entry.archive_name)}</dd><dt>包内路径</dt><dd>${escapeHtml(entry.internal_path)}</dd><dt>大小</dt><dd>${formatSize(entry.size)}</dd></dl>
    <p>加入清单后，Agent 会按包内路径定点提取，不需要先下载整个压缩包。</p>
    <button id="selectPreviewEntry" class="primary">加入下载清单</button>`);
  $('#selectPreviewEntry').addEventListener('click', () => { state.selectedEntries.add(id); updateSelectionBar(); });
}

async function createDownloadPlan() {
  const plan = await api('/api/download-plan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemIds: [...state.selectedItems], archiveEntryIds: [...state.selectedEntries] }),
  });
  state.selectedItems.clear(); state.selectedEntries.clear(); updateSelectionBar();
  showPreview(`<p class="eyebrow">AGENT DOWNLOAD PLAN</p><h2>下载任务 #${plan.jobId} 已保存</h2>
    <p>${escapeHtml(plan.note)}</p><div class="plan-list">${plan.plan.map(entry => `<div><strong>${escapeHtml(entry.name)}</strong><small>${entry.kind === 'archive_entry' ? `包内：${escapeHtml(entry.internalPath)}` : formatSize(entry.size)}</small></div>`).join('')}</div>
    <p class="preview-status">清单不会因刷新页面而丢失，浏览器 Agent 可直接读取并执行。</p>`);
  return plan;
}

async function showDownloadJobs() {
  const data = await api('/api/download-jobs');
  $('#downloadJobs').innerHTML = data.jobs.length ? data.jobs.map(job => `<button class="job-row quiet" data-job="${job.id}">
    <span>#${job.id} · ${escapeHtml(job.status)}</span><strong>${job.item_count} 项 · ${formatSize(job.total_size)}</strong><small>${escapeHtml(job.message || '')}</small>
  </button>`).join('') : '<p class="subtitle">还没有下载任务。</p>';
  $('#jobsPanel').classList.remove('hidden');
  document.querySelectorAll('.job-row').forEach(button => button.addEventListener('click', async () => {
    const detail = await api(`/api/download-jobs/${button.dataset.job}`);
    showPreview(`<p class="eyebrow">DOWNLOAD JOB</p><h2>下载任务 #${detail.job.id}</h2>
      <p class="preview-status">${escapeHtml(detail.job.status)} · ${escapeHtml(detail.job.message || '')}</p>
      <div class="plan-list">${detail.entries.map(entry => `<div><strong>${escapeHtml(entry.name)}</strong><small>${entry.kind === 'archive_entry' ? escapeHtml(entry.internal_path) : formatSize(entry.size)}</small></div>`).join('')}</div>`);
  }));
}

async function submitImport(input) {
  return api('/api/imports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}

async function pollImportJob(jobId) {
  const message = $('#importMessage');
  for (;;) {
    const data = await api('/api/imports');
    const job = data.jobs.find(entry => entry.id === jobId);
    if (!job) return;
    message.textContent = `任务 #${job.id} · ${job.progress}% · ${job.message || job.stage}`;
    if (job.status === 'complete' || job.status === 'error') {
      const refreshed = await api('/api/status');
      renderStats(refreshed); renderSources(refreshed.sources);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

async function openLogin(mode) {
  const data = await api('/api/auth/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
  window.open(data.officialUrl, 'baidu-official-login', 'width=520,height=720');
}

function registerAgentTools() {
  const registry = document.modelContext;
  if (typeof registry?.registerTool !== 'function') return;
  const lifecycle = new AbortController();
  const register = tool => Promise.resolve(registry.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
  register({ name: 'import_baidu_share', description: 'Import a Baidu Netdisk share recursively from its URL and extraction code.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, pwd: { type: 'string' }, name: { type: 'string' } }, required: ['url'], additionalProperties: false }, execute: submitImport });
  register({ name: 'search_materials', description: 'Search ordinary files and archive entries in the material library.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, source: { type: 'integer' } }, required: ['q'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: input => api(`/api/agent/search?${new URLSearchParams({ q: String(input.q), source: String(input.source || 0), limit: '200' })}`) });
  register({ name: 'preview_material', description: 'Read metadata and the root archive listing for one indexed item.', inputSchema: { type: 'object', properties: { itemId: { type: 'integer' } }, required: ['itemId'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: input => api(`/api/agent/preview/${Number(input.itemId)}`) });
  register({ name: 'create_download_plan', description: 'Create a download plan from selected ordinary item IDs and archive-entry IDs.', inputSchema: { type: 'object', properties: { itemIds: { type: 'array', items: { type: 'integer' } }, archiveEntryIds: { type: 'array', items: { type: 'integer' } } }, additionalProperties: false }, execute: input => api('/api/agent/download-plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) });
  register({ name: 'list_download_jobs', description: 'List persisted download jobs and their current Agent execution status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => api('/api/agent/download-jobs') });
}

async function boot() {
  const status = await api('/api/status');
  renderStats(status);
  renderSources(status.sources);
  await selectSource(0);
  $('#searchButton').addEventListener('click', search);
  $('#searchInput').addEventListener('keydown', event => { if (event.key === 'Enter') search(); });
  $('#typeFilter').addEventListener('change', search);
  $('#includeSystem').addEventListener('change', search);
  $('#loginButton').addEventListener('click', () => $('#loginPanel').classList.remove('hidden'));
  $('#closeLogin').addEventListener('click', () => $('#loginPanel').classList.add('hidden'));
  $('#importButton').addEventListener('click', () => $('#importPanel').classList.remove('hidden'));
  $('#closeImport').addEventListener('click', () => $('#importPanel').classList.add('hidden'));
  $('#jobsButton').addEventListener('click', showDownloadJobs);
  $('#closeJobs').addEventListener('click', () => $('#jobsPanel').classList.add('hidden'));
  $('#closePreview').addEventListener('click', () => $('#previewDrawer').classList.add('hidden'));
  $('#clearSelection').addEventListener('click', () => {
    state.selectedItems.clear(); state.selectedEntries.clear(); updateSelectionBar();
    document.querySelectorAll('.select-box input').forEach(input => { input.checked = false; });
  });
  $('#makeDownloadPlan').addEventListener('click', createDownloadPlan);
  document.querySelectorAll('.login-card').forEach(button => button.addEventListener('click', () => openLogin(button.dataset.mode)));
  $('#importForm').addEventListener('submit', async event => {
    event.preventDefault();
    const message = $('#importMessage');
    message.textContent = '正在创建自动导入任务…';
    try {
      const result = await submitImport({ url: $('#shareUrl').value, pwd: $('#sharePwd').value, name: $('#shareName').value });
      message.textContent = result.reused ? result.message : `任务 #${result.jobId} 已进入队列，Agent 将自动递归导入。`;
      const refreshed = await api('/api/status');
      renderStats(refreshed); renderSources(refreshed.sources);
      if (result.jobId) void pollImportJob(result.jobId);
    } catch (error) { message.textContent = `导入失败：${error.message}`; }
  });
  registerAgentTools();
  updateSelectionBar();
}

boot().catch(error => {
  $('#empty').classList.remove('hidden');
  $('#empty').textContent = `启动失败：${error.message}`;
});
