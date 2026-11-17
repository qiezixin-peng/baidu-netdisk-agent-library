// 普通 Node 子进程：从已下载到任务临时目录的 RAR 中选择性解压，不接触百度 Cookie。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createExtractorFromFile } from 'node-unrar-js';

function safeSegment(value) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || '_';
}

function segments(value) {
  const values = String(value || '').replaceAll('\\', '/').split('/').filter(Boolean);
  if (!values.length || values.some(value => value === '.' || value === '..')) throw new Error(`unsafe_archive_path:${value}`);
  return values;
}

const configFile = path.resolve(process.argv[2] || '');
if (!configFile) throw new Error('config_required');
const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
const archiveFile = path.resolve(config.archiveFile);
const outputRoot = path.resolve(config.outputRoot);
const allowedTemp = `${path.resolve('D:/三喜/临时文件')}${path.sep}`;
const allowedOutput = `${path.resolve('D:/三喜/下载的物料')}${path.sep}`;
if (!archiveFile.startsWith(allowedTemp) || !outputRoot.startsWith(allowedOutput)) throw new Error('unsafe_rar_paths');
await fs.mkdir(outputRoot, { recursive: true });

const relativeOutput = filename => segments(filename).map(safeSegment).join('/');
const extractor = await createExtractorFromFile({
  filepath: archiveFile,
  targetPath: outputRoot,
  filenameTransform: relativeOutput,
});
const headers = [...extractor.getFileList().fileHeaders];
const selectedNames = [...new Set(config.selections.flatMap(selection => {
  const prefix = segments(selection.internalPath).join('/');
  return headers.filter(header => {
    const actual = String(header.name).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    return !header.flags.directory && (selection.isDir ? actual.startsWith(`${prefix}/`) : actual === prefix);
  }).map(header => String(header.name));
}))];
if (!selectedNames.length) throw new Error('rar_entries_not_found');

const result = extractor.extract({ files: selectedNames });
const completed = new Set();
for (const file of result.files) completed.add(String(file.fileHeader.name).replaceAll('\\', '/').replace(/^\/+/, ''));
const outputs = config.selections.map(selection => {
  const wanted = segments(selection.internalPath).join('/');
  const found = selection.isDir ? [...completed].some(name => name.startsWith(`${wanted}/`)) : completed.has(wanted);
  if (!found) throw new Error(`rar_entry_not_found:${selection.internalPath}`);
  return { id: selection.id, outputPath: path.join(outputRoot, relativeOutput(selection.internalPath)) };
});
console.log(JSON.stringify({ ok: true, files: completed.size, outputs }));
