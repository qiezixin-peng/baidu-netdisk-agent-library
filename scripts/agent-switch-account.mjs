// 由 ego-browser nodejs 运行。仅在用户明确要求换号时注销网页会话，并停在百度官方二维码页面。
const fs = await import('node:fs/promises');

const projectRoot = 'D:/三喜/Agent工具/百度网盘物料库';
const sessionFile = `${projectRoot}/data/runtime/browser-session.json`;
let saved = null;
try { saved = JSON.parse(await fs.readFile(sessionFile, 'utf8')); } catch {}

const preferredSpaceId = Number(saved?.spaceId || 0);
const spaces = await listTaskSpaces();
const entry = spaces.find(space => space.id === preferredSpaceId);
const task = !entry
  ? await taskSpace('baidu-material-library-agent')
  : entry.ownership === 'user'
    ? await claimTaskSpace(preferredSpaceId)
    : entry.ownership === 'agentDelegatedToUser'
      ? await takeOverTaskSpace(preferredSpaceId)
      : await taskSpace(preferredSpaceId);

const pages = await task.pages();
let page = pages.find(candidate => candidate.label === saved?.pageLabel) || pages[0];
if (!page) {
  const tabs = await task.tabs();
  page = tabs[0] ? await task.adopt(tabs[0].page) : await task.newPage();
}

const target = 'https://pan.baidu.com/disk/main#/index?category=all';
const login = `https://passport.baidu.com/v2/?login&tpl=netdisk&subpro=netdisk_web&u=${encodeURIComponent(target)}`;
const logout = `https://passport.baidu.com/?logout&u=${encodeURIComponent(login)}`;
try { await page.goto(logout, { timeout: 30000 }); }
catch (error) { if (!String(error).includes('navigation committed')) throw error; }
await page.waitForTimeout(1500);
if (!/passport\.baidu\.com/.test(await page.url())) await page.goto(login, { timeout: 30000 });

await fs.mkdir(`${projectRoot}/data/runtime`, { recursive: true });
await fs.writeFile(sessionFile, JSON.stringify({
  spaceId: task.spaceId,
  pageLabel: page.label,
  authenticated: false,
  switchingAccount: true,
  checkedAt: new Date().toISOString(),
}, null, 2), 'utf8');

console.log(JSON.stringify({
  ok: false,
  authenticated: false,
  needsUserAction: 'scan_baidu_qr',
  nextCommand: 'node src/cli.mjs account-bind',
  taskSpaceId: task.spaceId,
  pageLabel: page.label,
}));
await task.handOff();
