import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './paths.mjs';

export const openConfigPath = path.join(projectRoot, 'config', 'baidu-open.local.json');
export const openTokenPath = path.join(projectRoot, 'data', 'runtime', 'baidu-open-token.json');

export function readOpenConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(openConfigPath, 'utf8')); } catch {}
  return {
    appKey: process.env.BAIDU_APP_KEY || file.appKey || '',
    secretKey: process.env.BAIDU_SECRET_KEY || file.secretKey || '',
    appName: process.env.BAIDU_APP_NAME || file.appName || '',
    redirectUri: process.env.BAIDU_REDIRECT_URI || file.redirectUri || 'oob',
  };
}

export function readOpenToken() {
  try { return JSON.parse(fs.readFileSync(openTokenPath, 'utf8')); } catch { return null; }
}

export async function writeOpenToken(value) {
  await fsp.mkdir(path.dirname(openTokenPath), { recursive: true });
  await fsp.writeFile(openTokenPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function buildUserInfoUrl(accessToken) {
  const url = new URL('https://pan.baidu.com/rest/2.0/xpan/nas');
  url.search = new URLSearchParams({ method: 'uinfo', access_token: accessToken }).toString();
  return url;
}

export async function getOpenUserInfo(accessToken, fetchImpl = fetch) {
  if (!accessToken) throw new Error('缺少百度开放平台 Access Token');
  const response = await fetchImpl(buildUserInfoUrl(accessToken), { headers: { 'User-Agent': 'pan.baidu.com' } });
  const data = await response.json();
  if (!response.ok || Number(data.errno || 0) !== 0) {
    throw new Error(`uinfo errno=${data.errno ?? response.status} ${data.errmsg || ''}`.trim());
  }
  const vipType = Number(data.vip_type || 0);
  return {
    accountId: String(data.uk || data.netdisk_name || ''),
    vipType,
    membership: vipType === 2 ? 'svip' : vipType === 1 ? 'vip' : 'standard',
  };
}

export function openApiReadiness(now = Date.now()) {
  const config = readOpenConfig();
  const token = readOpenToken();
  const expiresAt = Number(token?.expiresAt || 0);
  return {
    configured: Boolean(config.appKey && config.secretKey && config.appName),
    authorized: Boolean(token?.accessToken || token?.refreshToken),
    tokenFresh: Boolean(token?.accessToken && expiresAt > now + 5 * 60_000),
    appName: config.appName || null,
  };
}

async function requestToken(params, fetchImpl = fetch) {
  const url = new URL('https://openapi.baidu.com/oauth/2.0/token');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'pan.baidu.com' } });
  const data = await response.json();
  if (!response.ok || data.error || !data.access_token) {
    throw new Error(`百度 OAuth 失败: ${data.error_description || data.error || response.status}`);
  }
  const now = Date.now();
  const token = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt: now + Number(data.expires_in || 2_592_000) * 1000,
    scope: data.scope || '',
    updatedAt: new Date(now).toISOString(),
  };
  await writeOpenToken(token);
  return token;
}

export function buildAuthorizeUrl(config = readOpenConfig(), state = crypto.randomUUID()) {
  if (!config.appKey) throw new Error('缺少百度开放平台 AppKey');
  const url = new URL('https://openapi.baidu.com/oauth/2.0/authorize');
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.appKey, redirect_uri: config.redirectUri,
    scope: 'basic,netdisk', state, qrcode: '1', qrcodeW: '320', qrcodeH: '320',
  }).toString();
  return { url: url.toString(), state };
}

export async function exchangeAuthorizationCode(code, fetchImpl = fetch) {
  const config = readOpenConfig();
  if (!config.appKey || !config.secretKey) throw new Error('缺少百度开放平台 AppKey/SecretKey');
  return requestToken({
    grant_type: 'authorization_code', code, client_id: config.appKey,
    client_secret: config.secretKey, redirect_uri: config.redirectUri,
  }, fetchImpl);
}

export async function getAccessToken(fetchImpl = fetch) {
  const config = readOpenConfig();
  const token = readOpenToken();
  if (!config.appKey || !config.secretKey || !config.appName) return null;
  if (token?.accessToken && Number(token.expiresAt || 0) > Date.now() + 5 * 60_000) return token.accessToken;
  if (!token?.refreshToken) return null;
  const refreshed = await requestToken({
    grant_type: 'refresh_token', refresh_token: token.refreshToken,
    client_id: config.appKey, client_secret: config.secretKey,
  }, fetchImpl);
  return refreshed.accessToken;
}

export function buildListAllUrl({ accessToken, directory, start = 0, limit = 10_000 }) {
  const url = new URL('https://pan.baidu.com/rest/2.0/xpan/multimedia');
  url.search = new URLSearchParams({
    method: 'listall', access_token: accessToken, path: directory,
    web: '1', recursion: '1', start: String(start), limit: String(limit),
  }).toString();
  return url;
}

export async function listAllRecursive({ accessToken, directory, limit = 10_000, fetchImpl = fetch, onPage }) {
  const records = [];
  let start = 0;
  let pages = 0;
  const seenCursors = new Set();
  for (;;) {
    const url = buildListAllUrl({ accessToken, directory, start, limit });
    const response = await fetchImpl(url, { headers: { 'User-Agent': 'pan.baidu.com' } });
    const data = await response.json();
    if (!response.ok || Number(data.errno || 0) !== 0) {
      throw new Error(`listall errno=${data.errno ?? response.status} ${data.errmsg || ''}`.trim());
    }
    const page = Array.isArray(data.list) ? data.list : [];
    records.push(...page);
    pages += 1;
    await onPage?.({ pages, count: records.length, pageCount: page.length, cursor: data.cursor, hasMore: Boolean(data.has_more) });
    if (!Number(data.has_more)) break;
    const cursor = String(data.cursor ?? '');
    if (!cursor || seenCursors.has(cursor)) throw new Error('listall 返回了无效或重复游标');
    seenCursors.add(cursor);
    start = cursor;
  }
  return { records, pages };
}

export function mapListAllRecord(raw, { sourceId, tempRoot, sourceUrl }) {
  const remotePath = String(raw.path || '');
  let relative = remotePath.startsWith(tempRoot) ? remotePath.slice(tempRoot.length) : remotePath;
  if (!relative.startsWith('/')) relative = `/${relative}`;
  const itemPath = relative.replace(/\/+/g, '/');
  const separator = itemPath.lastIndexOf('/');
  const name = raw.server_filename || itemPath.slice(separator + 1);
  const isDir = Number(raw.isdir ?? raw.isdir ?? raw.is_dir ?? 0) === 1;
  const parentPath = separator <= 0 ? '/' : itemPath.slice(0, separator);
  const extension = isDir || !name.includes('.') ? '' : name.split('.').pop().toLowerCase().slice(0, 20);
  return {
    type: 'item', source_id: sourceId, fs_id: String(raw.fs_id || ''), path: itemPath,
    parent_path: parentPath, name, is_dir: isDir, size: Number(raw.size || 0),
    server_mtime: raw.server_mtime || null, category: raw.category ?? null, md5: raw.md5 || null,
    extension, open_url: `${sourceUrl}#list/path=${encodeURIComponent(isDir ? itemPath : parentPath)}&vmode=list`,
  };
}
