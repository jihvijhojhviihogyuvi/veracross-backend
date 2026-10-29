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
        throw e;
      }
    }
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(VERACROSS_LOGIN, { waitUntil: 'networkidle2', timeout: 30000 });
    currentUrl = page.url();
    startScreencast();
  } catch (err) {
    console.error('Browser init error:', err);
  }
}

function startScreencast() {
  if (screencastActive || !page) return;
  screencastActive = true;
  page.on('screencastFrame', (frame) => {
    latestFrame = frame.data;
    page.screencastFrameAck({ sessionId: frame.sessionId }).catch(() => {});
  });
  page.startScreencast({
    format: 'jpeg',
    quality: 60,
    maxWidth: 1280,
    maxHeight: 900,
    everyNthFrame: 1
  }).catch(err => console.error('Screencast error:', err));
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

// SSE endpoint for real-time streaming
app.get('/', (req, res) => {
  if (!browser) initBrowser();
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
  <h2>Veracross Remote Browser (Real-time)</h2>
  <p>Click on the image to interact. Type in the text field and press Enter.</p>
  <img id="screen" alt="Browser view" onclick="handleClick(event)">
  <div id="controls">
    <input type="text" id="textInput" placeholder="Type here and press Enter" onkeypress="handleKey(event)">
    <button onclick="goBack()">Back</button>
  </div>
  <div id="status">Connecting...</div>
</div>
<script>
  const img = document.getElementById('screen');
  const status = document.getElementById('status');
  const evtSource = new EventSource('/stream');
  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'frame') {
      img.src = 'data:image/jpeg;base64,' + msg.data;
    } else if (msg.type === 'status') {
      status.textContent = 'URL: ' + msg.url;
    } else if (msg.type === 'loginComplete') {
      evtSource.close();
      window.location.href = 'veracross://auth?cookie=' + encodeURIComponent(msg.cookie);
    }
  };
  evtSource.onerror = () => { status.textContent = 'Connection lost. Reconnecting...'; };

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
</script>
</body></html>`);
});

app.get('/stream', async (req, res) => {
  if (!browser) await initBrowser();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  const interval = setInterval(async () => {
    if (latestFrame) {
      res.write('data: ' + JSON.stringify({ type: 'frame', data: latestFrame }) + '\n\n');
    }
    await checkLogin();
    res.write('data: ' + JSON.stringify({ type: 'status', url: currentUrl, loginComplete }) + '\n\n');
    if (loginComplete) {
      res.write('data: ' + JSON.stringify({ type: 'loginComplete', cookie: sessionCookie }) + '\n\n');
      clearInterval(interval);
      res.end();
    }
  }, 200);
  req.on('close', () => clearInterval(interval));
});
app.post('/click', async (req, res) => {
  const { x, y } = req.body;
  if (page && x !== undefined && y !== undefined) {
    try {
      await page.mouse.click(x, y);
      await new Promise(r => setTimeout(r, 500));
      await checkLogin();
    } catch (err) { console.error('Click error:', err); }
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
    } catch (err) { console.error('Type error:', err); }
  }
  res.json({ ok: true });
});

app.post('/back', async (req, res) => {
  if (page) {
    try {
      await page.goBack();
      await new Promise(r => setTimeout(r, 1000));
      await checkLogin();
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', browser: !!browser, url: currentUrl });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
