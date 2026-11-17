// 由 ego-browser nodejs 运行。唯一允许用户介入的步骤是百度官方扫码登录。
const fs = await import('node:fs/promises');

const projectRoot = 'D:/三喜/Agent工具/百度网盘物料库';
const sessionFile = `${projectRoot}/data/runtime/browser-session.json`;
let saved = null;
try { saved = JSON.parse(await fs.readFile(sessionFile, 'utf8')); } catch {}

const preferredSpaceId = Number(saved?.spaceId || 32);
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

try {
  await page.goto('https://pan.baidu.com/disk/main#/index?category=all', { timeout: 30000 });
} catch (error) {
  if (!String(error).includes('navigation committed')) throw error;
}
await page.waitForTimeout(2500);
const auth = await page.evaluate(() => {
  const url = location.href;
  const text = document.body?.innerText || '';
  const locals = window.locals;
  let bdstoken = '';
  try { bdstoken = String(locals?.get?.('bdstoken') || locals?.dump?.()?.bdstoken?.value || ''); } catch {}
  return {
    authenticated: /pan\.baidu\.com\/disk\/main/.test(url) && (Boolean(bdstoken) || /我的文件|全部文件|传输列表/.test(text)),
    url,
  };
});

await fs.mkdir(`${projectRoot}/data/runtime`, { recursive: true });
await fs.writeFile(sessionFile, JSON.stringify({
  spaceId: task.spaceId,
  pageLabel: page.label,
  authenticated: auth.authenticated,
  checkedAt: new Date().toISOString(),
}, null, 2), 'utf8');

if (auth.authenticated) {
  console.log(JSON.stringify({ ok: true, authenticated: true, taskSpaceId: task.spaceId, pageLabel: page.label }));
} else {
  const redirect = encodeURIComponent('https://pan.baidu.com/disk/main#/index?category=all');
  await page.goto(`https://passport.baidu.com/v2/?login&tpl=netdisk&subpro=netdisk_web&u=${redirect}`, { timeout: 30000 });
  console.log(JSON.stringify({ ok: false, authenticated: false, needsUserAction: 'scan_baidu_qr', taskSpaceId: task.spaceId, pageLabel: page.label }));
  await task.handOff();
}
