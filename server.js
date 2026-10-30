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

const VERACROSS_LOGIN = 'https://portals.veracross.com/maimonides/student';

async function initBrowser() {
  if (browser) return;
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
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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
  }
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
      latestFrame = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 70 });
      await checkLogin();
    } catch (err) {
      console.error('Screenshot error:', err.message);
    }
  }, 100);
}

async function checkLogin() {
  if (!page) return;
  currentUrl = page.url();
  if (currentUrl.includes('/student') && !currentUrl.includes('login') && !currentUrl.includes('accounts.google')) {
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
</style>
</head><body>
<div id="container">
  <h2>Veracross Remote Browser (Real-time 10fps)</h2>
  <p>Click on the image to interact. Type in the text field and press Enter.</p>
  <img id="screen" alt="Browser view" onclick="handleClick(event)">
  <div id="controls">
    <input type="text" id="textInput" placeholder="Type here and press Enter" onkeypress="handleKey(event)">
    <button onclick="goBack()">Back</button>
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
    setTimeout(refresh, 500);
  }

  function handleKey(e) {
    if (e.key === 'Enter') {
      const text = document.getElementById('textInput').value;
      document.getElementById('textInput').value = '';
      fetch('/type', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text}) });
      setTimeout(refresh, 500);
    }
  }

  function goBack() {
    fetch('/back', { method: 'POST' });
    setTimeout(refresh, 1000);
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

app.get('/status', async (req, res) => {
  if (!browser) await initBrowser();
  res.json({ url: currentUrl, loginComplete, browser: !!browser, cookie: sessionCookie });
});

app.post('/click', async (req, res) => {
  const { x, y } = req.body;
  if (page && x !== undefined && y !== undefined) {
    try {
      await page.mouse.click(x, y);
      await new Promise(r => setTimeout(r, 500));
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
      await new Promise(r => setTimeout(r, 300));
      await checkLogin();
    } catch (err) { console.error('Type error:', err.message); }
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
