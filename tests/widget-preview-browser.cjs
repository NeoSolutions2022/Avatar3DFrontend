const { chromium } = require('C:/Users/felip/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const host = 'https://widget.test';
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(host + '/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/v1/widget/config') return route.fulfill({ json: { allowed_origins: ['*'] } });
      const file = url.pathname === '/widget' ? path.join(root, 'frontend/widget.html') : url.pathname.startsWith('/static/') ? path.join(root, 'frontend', url.pathname.slice(8)) : path.join(root, url.pathname.slice(1));
      try { await route.fulfill({ body: await fs.readFile(file), contentType: mime[path.extname(file)] || 'application/octet-stream' }); }
      catch { await route.fulfill({ status: 404 }); }
    });
    await page.goto(host + '/widget?avatar=elia&loop=0');
    await page.locator('#widget-loader').waitFor({ state: 'hidden', timeout: 120000 });
    assert.deepEqual(errors, []);
    const out = path.resolve(root, '../../outputs/widget-silent-preview.png');
    await page.screenshot({ path: out });
    console.log('PASS: silent Elia preview becomes visible without microphone, API translation or speech.', out);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
