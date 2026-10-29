const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let browser = null;
let page = null;
let screenshot = null;
let currentUrl = '';
let loginComplete = false;
let sessionCookie = null;

const VERACROSS_LOGIN = 'https://portals.veracross.com/maimonides/student';

async function initBrowser() {
  if (browser) return;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(VERACROSS_LOGIN, { waitUntil: 'networkidle2', timeout: 30000 });
    await updateScreenshot();
  } catch (err) {
    console.error('Browser init error:', err);
  }
}

async function updateScreenshot() {
  if (!page) return;
  try {
    screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 });
    currentUrl = page.url();
    if (currentUrl.includes('/student') && !currentUrl.includes('login') && !currentUrl.includes('accounts.google')) {
      const cookies = await page.cookies();
      const allCookies = cookies
        .filter(c => c.domain.includes('veracross.com'))
        .map(c => c.name + '=' + c.value)
        .join('; ');
      if (allCookies) {
        loginComplete = true;
        sessionCookie = allCookies;
      }
    }
  } catch (err) {
    console.error('Screenshot error:', err);
  }
}
app.get('/', async (req, res) => {
  if (!browser) await initBrowser();
  res.send(`<!DOCTYPE html>
<html><head><title>Veracross Remote Browser</title>
<style>
  body { margin: 0; font-family: sans-serif; background: #f0f0f0; }
  #container { max-width: 800px; margin: 0 auto; padding: 10px; }
  #screen { width: 100%; border: 1px solid #ccc; cursor: crosshair; }
  #controls { margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap; }
  #controls input { flex: 1; min-width: 200px; padding: 8px; }
  #controls button { padding: 8px 16px; }
  #status { margin-top: 10px; padding: 10px; background: #fff; border-radius: 4px; }
</style>
</head><body>
<div id="container">
  <h2>Veracross Remote Browser</h2>
  <p>Click on the image to interact. Type in the text field and press Enter.</p>
  <img id="screen" src="/screenshot" alt="Browser view" onclick="handleClick(event)">
  <div id="controls">
    <input type="text" id="textInput" placeholder="Type here and press Enter" onkeypress="handleKey(event)">
    <button onclick="refresh()">Refresh</button>
    <button onclick="goBack()">Back</button>
  </div>
  <div id="status">Loading...</div>
</div>
<script>
  let clicking = false;
  async function refresh() {
    const img = document.getElementById('screen');
    img.src = '/screenshot?t=' + Date.now();
    const res = await fetch('/status');
    const data = await res.json();
    document.getElementById('status').textContent = 'URL: ' + data.url;
    if (data.loginComplete) { window.location.href = '/done'; }
  }
  async function handleClick(e) {
    if (clicking) return;
    clicking = true;
    const img = document.getElementById('screen');
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    await fetch('/click', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({x, y}) });
    await new Promise(r => setTimeout(r, 1500));
    await refresh();
    clicking = false;
  }
  async function handleKey(e) {
    if (e.key === 'Enter') {
      const text = document.getElementById('textInput').value;
      document.getElementById('textInput').value = '';
      await fetch('/type', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text}) });
      await new Promise(r => setTimeout(r, 1000));
      await refresh();
    }
  }
  async function goBack() {
    await fetch('/back', { method: 'POST' });
    await new Promise(r => setTimeout(r, 1500));
    await refresh();
  }
  setInterval(refresh, 3000);
  refresh();
</script>
</body></html>`);
});

app.get('/screenshot', async (req, res) => {
  if (!screenshot) await updateScreenshot();
  if (!screenshot) return res.status(500).send('No screenshot');
  const buf = Buffer.from(screenshot, 'base64');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-cache');
  res.send(buf);
});

app.get('/status', async (req, res) => {
  if (!browser) await initBrowser();
  await updateScreenshot();
  res.json({ url: currentUrl, loginComplete });
});

app.post('/click', async (req, res) => {
  const { x, y } = req.body;
  if (page && x !== undefined && y !== undefined) {
    try {
      await page.mouse.click(x, y);
      await new Promise(r => setTimeout(r, 1500));
      await updateScreenshot();
    } catch (err) { console.error('Click error:', err); }
  }
  res.json({ ok: true });
});

app.post('/type', async (req, res) => {
  const { text } = req.body;
  if (page && text) {
    try {
      await page.keyboard.type(text);
      await new Promise(r => setTimeout(r, 500));
      await updateScreenshot();
    } catch (err) { console.error('Type error:', err); }
  }
  res.json({ ok: true });
});

app.post('/back', async (req, res) => {
  if (page) {
    try {
      await page.goBack();
      await new Promise(r => setTimeout(r, 1500));
      await updateScreenshot();
    } catch (err) { console.error('Back error:', err); }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
