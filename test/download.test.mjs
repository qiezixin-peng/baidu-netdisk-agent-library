import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpRangeReader, TextReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';

test('ZIP 下载器只通过 Range 读取并提取指定条目', async t => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add('分轨/目标.txt', new TextReader('只提取这一项'));
  await writer.add('分轨/其他.txt', new TextReader('不需要的内容'.repeat(1000)));
  const archive = Buffer.from(await writer.close());
  let rangedRequests = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('accept-ranges', 'bytes');
    if (request.method === 'HEAD') {
      response.setHeader('content-length', archive.length);
      return response.end();
    }
    const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) {
      response.statusCode = 200;
      response.setHeader('content-length', archive.length);
      return response.end(archive);
    }
    rangedRequests += 1;
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), archive.length - 1) : archive.length - 1;
    const body = archive.subarray(start, end + 1);
    response.statusCode = 206;
    response.setHeader('content-range', `bytes ${start}-${end}/${archive.length}`);
    response.setHeader('content-length', body.length);
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const reader = new ZipReader(new HttpRangeReader(`http://127.0.0.1:${port}/archive.zip`, { maximumRangeSize: 128 }));
  t.after(() => reader.close());
  const entries = await reader.getEntries();
  const target = entries.find(entry => entry.filename === '分轨/目标.txt');
  assert.ok(target);
  const content = await target.getData(new Uint8ArrayWriter());
  assert.equal(new TextDecoder().decode(content), '只提取这一项');
  assert.ok(rangedRequests > 0);
});
