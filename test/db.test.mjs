import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifyItem, extensionOf, migrate } from '../src/db.mjs';
import { importJsonl } from '../src/importer.mjs';
import { createDownloadJob, enqueueImportJob, normalizeShareInput } from '../src/server.mjs';
import { buildListAllUrl, getOpenUserInfo, listAllRecursive, mapListAllRecord } from '../src/baidu-open-api.mjs';

test('识别常用物料类型', () => {
  assert.equal(extensionOf('伴奏.WAV', false), 'wav');
  assert.equal(extensionOf('成品物料.zip', false), 'zip');
  assert.equal(extensionOf('文件夹', true), '');
  assert.equal(classifyItem({ is_dir: 0, extension: 'wav' }), 'audio');
  assert.equal(classifyItem({ is_dir: 0, extension: 'zip' }), 'archive');
  assert.equal(classifyItem({ is_dir: 1, extension: '' }), 'folder');
});

test('可从整段百度分享文字识别链接和提取码', () => {
  const parsed = normalizeShareInput({ url: '通过网盘分享的文件：歌曲物料\n链接: https://pan.baidu.com/s/1Ab_C-d?foo=1 提取码: a9Z2\n--来自百度网盘' });
  assert.equal(parsed.url, 'https://pan.baidu.com/s/1Ab_C-d?pwd=a9Z2');
  assert.equal(parsed.pwd, 'a9Z2');
  assert.equal(parsed.rescan, false);
});

test('Agent 可直接创建分享导入任务', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const result = enqueueImportJob(db, { url: '链接: https://pan.baidu.com/s/1AgentTest 提取码: a1B2' });
  assert.equal(result.status, 'queued');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM import_jobs').get().count, 1);
  assert.equal(db.prepare('SELECT pwd FROM sources WHERE id=?').get(result.sourceId).pwd, 'a1B2');
  db.close();
});

test('迁移创建可持久化下载任务表', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='download_jobs'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='download_job_entries'").get());
  db.close();
});

test('Agent 可把普通文件和包内文件固化为下载任务', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO sources(id,name,root_name,url,pwd) VALUES(1,'来源','根','https://example.test','')`).run();
  db.prepare(`INSERT INTO items(id,source_id,path,parent_path,name,extension,size) VALUES
    (1,1,'/根/成品.wav','/根','成品.wav','wav',10),
    (2,1,'/根/分轨.zip','/根','分轨.zip','zip',100)`).run();
  db.prepare(`INSERT INTO archive_entries(id,item_id,internal_path,parent_internal_path,name,size,extension)
    VALUES(3,2,'/分轨/鼓.wav','/分轨','鼓.wav',20,'wav')`).run();
  const result = createDownloadJob(db, { itemIds: [1], archiveEntryIds: [3] });
  assert.equal(result.count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM download_job_entries WHERE job_id=?').get(result.jobId).count, 2);
  db.close();
});

test('目录检查点可在完整扫描结束前进入搜索库', async t => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO sources(id,name,root_name,url,pwd) VALUES(1,'来源','','https://example.test','')`).run();
  const tempRoot = path.resolve(import.meta.dirname, '..', '..', '临时文件');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, '渐进索引测试-'));
  const filename = path.join(dir, 'checkpoint.jsonl');
  fs.writeFileSync(filename, [
    JSON.stringify({ type: 'source', source_id: 1, name: '来源', root_name: '根', complete: false }),
    JSON.stringify({ type: 'item', source_id: 1, fs_id: '1', path: '/根/先出现.wav', parent_path: '/根', name: '先出现.wav', size: 10 })
  ].join('\n') + '\n');
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await importJsonl(db, filename);
  assert.equal(db.prepare('SELECT scan_status FROM sources WHERE id=1').get().scan_status, 'partial');
  assert.equal(db.prepare('SELECT name FROM items WHERE source_id=1').get().name, '先出现.wav');
});

test('未确认的空扫描不能误报完整', async t => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO sources(id,name,root_name,url,pwd) VALUES(1,'空扫描','','https://example.test','')`).run();
  const tempRoot = path.resolve(import.meta.dirname, '..', '..', '临时文件');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, '空扫描测试-'));
  const filename = path.join(dir, 'source.jsonl');
  fs.writeFileSync(filename, `${JSON.stringify({ type: 'source', source_id: 1, name: '空扫描', complete: true })}\n`);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const result = await importJsonl(db, filename);
  const source = db.prepare('SELECT scan_status,item_count,error FROM sources WHERE id=1').get();
  assert.equal(result.complete, false);
  assert.equal(source.scan_status, 'error');
  assert.equal(source.item_count, 0);
  assert.equal(source.error, 'empty_scan_unverified');
});

test('导入并递归浏览压缩包目录元数据', async t => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO sources(id,name,root_name,url,pwd) VALUES(1,'来源','根','https://example.test','')`).run();
  db.prepare(`INSERT INTO items(id,source_id,path,parent_path,name,extension) VALUES(9,1,'/根/物料.zip','/根','物料.zip','zip')`).run();
  const tempRoot = path.resolve(import.meta.dirname, '..', '..', '临时文件');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, '物料库测试-'));
  const filename = path.join(dir, 'archive.jsonl');
  fs.writeFileSync(filename, [
    JSON.stringify({ type: 'archive', item_id: 9, status: 'complete', replace_entries: true }),
    JSON.stringify({ type: 'archive_entry', item_id: 9, internal_path: '/母带', parent_internal_path: '/', name: '母带', is_dir: true }),
    JSON.stringify({ type: 'archive_entry', item_id: 9, internal_path: '/母带/成品.wav', parent_internal_path: '/母带', name: '成品.wav', size: 123 })
  ].join('\n') + '\n');
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const result = await importJsonl(db, filename);
  assert.equal(result.archiveEntries, 2);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM archive_entries WHERE parent_internal_path=?').get('/母带').count, 1);
  assert.equal(db.prepare('SELECT status FROM archive_scans WHERE item_id=9').get().status, 'complete');
});

test('listall 使用服务端游标读取完整递归清单', async () => {
  const starts = [];
  const fetchImpl = async url => {
    starts.push(url.searchParams.get('start'));
    const first = starts.length === 1;
    return {
      ok: true,
      async json() {
        return first
          ? { errno: 0, has_more: 1, cursor: 9001, list: [{ fs_id: 1, path: '/apps/demo/job/根/a.wav' }] }
          : { errno: 0, has_more: 0, cursor: 9002, list: [{ fs_id: 2, path: '/apps/demo/job/根/b.wav' }] };
      },
    };
  };
  const result = await listAllRecursive({ accessToken: 'secret', directory: '/apps/demo/job', fetchImpl });
  assert.deepEqual(starts, ['0', '9001']);
  assert.equal(result.pages, 2);
  assert.equal(result.records.length, 2);
});

test('listall URL 开启递归且单页最多请求一万项', () => {
  const url = buildListAllUrl({ accessToken: 'token', directory: '/apps/demo/job' });
  assert.equal(url.searchParams.get('method'), 'listall');
  assert.equal(url.searchParams.get('recursion'), '1');
  assert.equal(url.searchParams.get('limit'), '10000');
});

test('识别开放平台账号会员等级', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ errno: 0, uk: 123456, vip_type: 2 }),
  });
  assert.deepEqual(await getOpenUserInfo('token', fakeFetch), {
    accountId: '123456', vipType: 2, membership: 'svip',
  });
});

test('快速清单会剥离临时转存目录并保留分享目录结构', () => {
  const item = mapListAllRecord({
    fs_id: 42, path: '/apps/demo/Agent自动导入_7/歌曲物料/母带/成品.WAV',
    server_filename: '成品.WAV', isdir: 0, size: 123,
  }, { sourceId: 7, tempRoot: '/apps/demo/Agent自动导入_7', sourceUrl: 'https://pan.baidu.com/s/test' });
  assert.equal(item.path, '/歌曲物料/母带/成品.WAV');
  assert.equal(item.parent_path, '/歌曲物料/母带');
  assert.equal(item.extension, 'wav');
});
