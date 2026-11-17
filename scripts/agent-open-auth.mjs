// 由 ego-browser nodejs 运行。用户只需在百度官方页面扫码，授权确认由 Agent 完成。
const fs = await import('node:fs/promises');
const { buildAuthorizeUrl, exchangeAuthorizationCode, getAccessToken, openApiReadiness, readOpenConfig } = await import('file:///D:/三喜/Agent工具/百度网盘物料库/src/baidu-open-api.mjs');

const config = readOpenConfig();
const readiness = openApiReadiness();
const forceAuthorization = Boolean(globalThis.BAIDU_FORCE_AUTHORIZATION);
if (!readiness.configured) {
  console.log(JSON.stringify({ ok: false, configured: false, needsConfiguration: 'baidu_open_platform_app' }));
} else if (readiness.tokenFresh && !forceAuthorization) {
  console.log(JSON.stringify({ ok: true, configured: true, authorized: true, appName: readiness.appName }));
} else {
  if (readiness.authorized && !forceAuthorization) {
    try {
      const refreshed = await getAccessToken();
      if (refreshed) {
        console.log(JSON.stringify({ ok: true, configured: true, authorized: true, refreshed: true, appName: readiness.appName }));
        process.exit(0);
      }
    } catch {}
  }
  let saved = null;
  try { saved = JSON.parse(await fs.readFile('D:/三喜/Agent工具/百度网盘物料库/data/runtime/browser-session.json', 'utf8')); } catch {}
  const requestedSpace = globalThis.BAIDU_MATERIAL_SPACE_ID || saved?.spaceId || null;
  const entry = requestedSpace == null ? null : (await listTaskSpaces()).find(space => space.id === Number(requestedSpace));
  const task = !entry
    ? await taskSpace(requestedSpace || 'baidu-material-library-agent')
    : entry.ownership === 'user'
      ? await claimTaskSpace(entry.id)
      : entry.ownership === 'agentDelegatedToUser'
        ? await takeOverTaskSpace(entry.id)
        : await taskSpace(entry.id);
  const pages = await task.pages();
  const pageStates = await Promise.all(pages.map(async candidate => ({ page: candidate, url: await candidate.url() })));
  let page = pageStates.find(candidate => /openapi\.baidu\.com\/oauth|oauth\/2\.0/.test(candidate.url))?.page
    || pages.find(candidate => candidate.label === (globalThis.BAIDU_SCAN_PAGE_LABEL || saved?.pageLabel)) || pages[0];
  if (!page) page = await task.newPage();
  const extractCode = async () => {
    const current = new URL(await page.url());
    return current.searchParams.get('code') || await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const inputCode = [...document.querySelectorAll('input,textarea')]
        .map(node => String(node.value || '').trim())
        .find(value => /^[A-Za-z0-9._-]{20,}$/.test(value));
      return inputCode || /(?:code\s*[=:：]\s*)([A-Za-z0-9._-]{12,})/i.exec(text)?.[1] || '';
    }).catch(() => '');
  };
  const existingCode = forceAuthorization ? '' : await extractCode();
  if (existingCode) {
    await exchangeAuthorizationCode(existingCode);
    console.log(JSON.stringify({ ok: true, configured: true, authorized: true, appName: config.appName }));
    process.exit(0);
  }
  const { url, state } = buildAuthorizeUrl(config);
  try { await page.goto(url, { timeout: 30000 }); }
  catch (error) { if (!String(error).includes('navigation committed')) throw error; }
  await page.waitForTimeout(1500);
  const clickAuthorization = async () => page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button,a,input[type=button],input[type=submit]')];
    const target = candidates.find(node => /同意|授权|确认/.test(node.textContent || node.value || ''));
    if (!target) return false;
    target.click();
    return true;
  });
  await clickAuthorization().catch(() => false);
  let code = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await page.url();
    const parsed = new URL(current);
    if (parsed.searchParams.get('state') && parsed.searchParams.get('state') !== state) throw new Error('百度 OAuth state 不匹配');
    code = parsed.searchParams.get('code') || await extractCode();
    if (code) break;
    await page.waitForTimeout(750);
    await clickAuthorization().catch(() => false);
  }
  if (!code) {
    console.log(JSON.stringify({ ok: false, configured: true, authorized: false, needsUserAction: 'scan_baidu_qr', taskSpaceId: task.spaceId, pageLabel: page.label }));
    await task.handOff();
  } else {
    await exchangeAuthorizationCode(code);
    console.log(JSON.stringify({ ok: true, configured: true, authorized: true, appName: config.appName }));
  }
}
