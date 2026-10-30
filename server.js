const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let browser = null;
let page = null;
let currentUrl = '';
let loginComplete = false;
let sessionCookie = null;
let latestFrame = null;
let screencastActive = false;
let browserError = null;
let initPromise = null;
let sessionId = 0;

const VERACROSS_LOGIN = 'https://portals.veracross.com/maimonides/student';

async function resetBrowser() {
  if (browser) {
    try { await browser.close(); } catch (e) {}
    browser = null;
    page = null;
    currentUrl = '';
    loginComplete = false;
    sessionCookie = null;
    latestFrame = null;
    screencastActive = false;
  }
  await initBrowser();
}

async function initBrowser() {
  if (browser) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
  try {
    const chromePaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable'
    ].filter(Boolean);

    let launched = false;
    for (const chromePath of chromePaths) {
      try {
        const fs = require('fs');
        if (!fs.existsSync(chromePath)) continue;
        browser = await puppeteer.launch({
          executablePath: chromePath,
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        launched = true;
        console.log('Launched Chrome from:', chromePath);
        break;
      } catch (e) {
        console.log('Failed to launch from', chromePath, ':', e.message);
      }
    }
    if (!launched) {
      try {
        browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        launched = true;
        console.log('Launched bundled Chrome');
      } catch (e) {
        console.error('All Chrome launch attempts failed:', e.message);
        browserError = e.message;
        throw e;
      }
    }
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(VERACROSS_LOGIN, { waitUntil: 'networkidle2', timeout: 30000 });
    currentUrl = page.url();
    startScreenshotPolling();
  } catch (err) {
    console.error('Browser init error:', err);
    browserError = err.message;
  } finally {
    initPromise = null;
  }
  })();
  return initPromise;
}

function startScreenshotPolling() {
  if (screencastActive || !page) return;
  screencastActive = true;
  setInterval(async () => {
    if (!page) return;
    try {
      if (page.isClosed()) {
        console.log('Page closed, reinitializing...');
        browser = null;
        page = null;
        screencastActive = false;
        await initBrowser();
        return;
      }
      latestFrame = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 50 });
      await checkLogin();
    } catch (err) {
      console.error('Screenshot error:', err.message);
      if (err.message && (err.message.includes('closed') || err.message.includes('detached'))) {
        browser = null;
        page = null;
        screencastActive = false;
        await initBrowser();
      }
    }
  }, 100);
}

async function checkLogin() {
  if (!page) return;
  currentUrl = page.url();
  if (currentUrl.includes('/student') && !currentUrl.includes('login') && !currentUrl.includes('accounts.google') && !currentUrl.includes('accounts.veracross')) {
    const cookies = await page.cookies();
    const allCookies = cookies
      .filter(c => c.domain.includes('veracross.com'))
      .map(c => c.name + '=' + c.value)
      .join('; ');
    if (allCookies && !loginComplete) {
      loginComplete = true;
      sessionCookie = allCookies;
    }
  }
}

app.get('/', async (req, res) => {
  // Reset browser for new session (multi-user support)
  if (req.query.reset === '1') {
    await resetBrowser();
  }
  if (!browser) await initBrowser();
  res.send(`<!DOCTYPE html>
<html><head><title>Veracross Remote Browser</title>
<style>
  body { margin: 0; font-family: sans-serif; background: #1a1a1a; color: #fff; }
  #container { max-width: 900px; margin: 0 auto; padding: 10px; }
  #screen { width: 100%; border: 2px solid #333; cursor: crosshair; background: #000; }
  #controls { margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  #textInput { flex: 1; min-width: 200px; padding: 10px; font-size: 16px; }
  button { padding: 10px 20px; font-size: 16px; cursor: pointer; }
  #status { margin-top: 10px; padding: 10px; background: #2a2a2a; border-radius: 4px; font-size: 14px; }
  #resetBtn { background: #c00; color: #fff; }
</style>
</head><body>
<div id="container">
  <h2>Veracross Remote Browser (10fps)</h2>
  <p>Click on the image to interact. Type in the text field and press Enter.</p>
  <img id="screen" alt="Browser view" onclick="handleClick(event)">
  <div id="controls">
    <input type="text" id="textInput" placeholder="Type here and press Enter" onkeypress="handleKey(event)">
    <button onclick="goBack()">Back</button>
    <button onclick="loadGoogle()">Load Google Sign-In</button>
    <input type="text" id="urlInput" placeholder="Enter URL" style="flex:1;min-width:200px;padding:8px;">
    <button onclick="navigate()">Go</button>

    <button onclick="clickGoogle()">Click Google Sign-In</button>
    <button onclick="scrollDown()">Scroll Down</button>
    <button onclick="scrollUp()">Scroll Up</button>

    <button id="resetBtn" onclick="resetBrowser()">Reset (new session)</button>
  </div>
  <div id="status">Loading...</div>
</div>
<script>
  const img = document.getElementById('screen');
  const status = document.getElementById('status');

  async function refresh() {
    try {
      const res = await fetch('/screenshot?t=' + Date.now());
      if (res.ok) {
        const blob = await res.blob();
        img.src = URL.createObjectURL(blob);
      }
      const st = await fetch('/status');
      const data = await st.json();
      status.textContent = 'URL: ' + data.url + (data.loginComplete ? ' [LOGGED IN]' : '');
      if (data.loginComplete) {
        window.location.href = 'veracross://auth?cookie=' + encodeURIComponent(data.cookie);
      }
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
  }

  function handleClick(e) {
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    fetch('/click', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({x, y}) });
  }

  function handleKey(e) {
    if (e.key === 'Enter') {
      const text = document.getElementById('textInput').value;
      document.getElementById('textInput').value = '';
      fetch('/type', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text}) });
    }
  }

  function goBack() {
    fetch('/back', { method: 'POST' });
  }

  async function loadGoogle() {
    status.textContent = 'Navigating to Google Sign-In...';
    const res = await fetch('/navigate', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url: 'https://accounts.google.com/signin'}) });
    const data = await res.json();
    status.textContent = data.ok ? 'Loaded: ' + data.url : 'Error: ' + (data.error || 'unknown');
    setTimeout(refresh, 2000);
  }

  async function navigate() {
    const url = document.getElementById('urlInput').value;
    if (!url) return;
    status.textContent = 'Navigating to ' + url + '...';
    const res = await fetch('/navigate', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url}) });
    const data = await res.json();
    status.textContent = data.ok ? 'Loaded: ' + data.url : 'Error: ' + (data.error || 'unknown');
    setTimeout(refresh, 2000);
  }


  async function clickGoogle() {
    status.textContent = 'Clicking Google Sign-In...';
    const res = await fetch('/clickGoogle', { method: 'POST' });
    const data = await res.json();
    status.textContent = data.ok ? 'Clicked Google Sign-In. Waiting...' : 'Could not find Google button: ' + (data.error || '');
    setTimeout(refresh, 3000);
  }

  async function scrollDown() {
    await fetch('/scrollDown', { method: 'POST' });
    setTimeout(refresh, 500);
  }

  async function scrollUp() {
    await fetch('/scrollUp', { method: 'POST' });
    setTimeout(refresh, 500);
  }


  async function resetBrowser() {
    status.textContent = 'Resetting browser...';
    await fetch('/reset', { method: 'POST' });
    img.src = '';
    setTimeout(refresh, 2000);
  }

  setInterval(refresh, 100);
  refresh();
</script>
</body></html>`);
});

app.get('/screenshot', async (req, res) => {
  if (!latestFrame) {
    if (!browser) await initBrowser();
    return res.status(503).send('No screenshot yet');
  }
  const buf = Buffer.from(latestFrame, 'base64');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-cache');
  res.send(buf);
});
app.post('/navigate', async (req, res) => {
  const { url } = req.body;
  if (page && url) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await checkLogin();
      res.json({ ok: true, url: page.url() });
    } catch (err) {
      console.error('Navigate error:', err.message);
      res.json({ ok: false, error: err.message });
    }
  } else {
    res.json({ ok: false, error: 'no page or url' });
  }
});



app.get('/status', async (req, res) => {
  if (!browser) await initBrowser();
  res.json({ url: currentUrl, loginComplete, browser: !!browser, cookie: sessionCookie });
});

app.post('/click', async (req, res) => {
  const { x, y } = req.body;
  if (page && x !== undefined && y !== undefined) {
    try {
      await page.mouse.click(x, y);
      await new Promise(r => setTimeout(r, 300));
      await checkLogin();
    } catch (err) { console.error('Click error:', err.message); }
  }
  res.json({ ok: true });
});

app.post('/type', async (req, res) => {
  const { text } = req.body;
  if (page && text) {
    try {
      await page.keyboard.type(text);
      await new Promise(r => setTimeout(r, 200));
      await checkLogin();
    } catch (err) { console.error('Type error:', err.message); }
  }
  res.json({ ok: true });
});

app.post('/clickGoogle', async (req, res) => {
  if (!page) { res.json({ ok: false, error: 'no page' }); return; }
  try {
    const clicked = await page.evaluate(() => {
      const els = document.querySelectorAll('a, button, div[role="button"]');
      for (const el of els) {
        if (el.textContent && el.textContent.toLowerCase().includes('google')) {
          el.click();
          return true;
        }
        if (el.getAttribute('href') && el.getAttribute('href').includes('accounts.google.com')) {
          el.click();
          return true;
        }
      }
      return false;
    });
    console.log('clickGoogle result:', clicked);
    await new Promise(r => setTimeout(r, 3000));
    await checkLogin();
    res.json({ ok: clicked });
  } catch (err) {
    console.error('clickGoogle error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.post('/scrollDown', async (req, res) => {
  if (page) {
    try { await page.evaluate(() => window.scrollBy(0, 400)); await new Promise(r => setTimeout(r, 500)); } catch (e) {}
  }
  res.json({ ok: true });
});

app.post('/scrollUp', async (req, res) => {
  if (page) {
    try { await page.evaluate(() => window.scrollBy(0, -400)); await new Promise(r => setTimeout(r, 500)); } catch (e) {}
  }
  res.json({ ok: true });
});


app.post('/back', async (req, res) => {
  if (page) {
    try {
      await page.goBack();
      await new Promise(r => setTimeout(r, 1000));
      await checkLogin();
    } catch (err) { console.error('Back error:', err.message); }
  }
  res.json({ ok: true });
});

app.post('/reset', async (req, res) => {
  await resetBrowser();
  res.json({ ok: true });
});

app.get('/done', (req, res) => {
  if (!sessionCookie) {
    return res.send('Login not complete yet. Go back and try again.');
  }
  const deepLink = 'veracross://auth?cookie=' + encodeURIComponent(sessionCookie);
  res.send('<!DOCTYPE html><html><head><title>Redirecting...</title></head><body><p>Login successful!</p><script>window.location.href = "' + deepLink + '";</script><p><a href="' + deepLink + '">Tap here</a></p></body></html>');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', browser: !!browser, url: currentUrl, error: browserError });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
