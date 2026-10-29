const express = require('express');
const puppeteer = require('puppeteer');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let browser = null;
let page = null;
let currentUrl = '';
let loginComplete = false;
let sessionCookie = null;
let screencastActive = false;

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
    const msg = JSON.stringify({ type: 'frame', data: frame.data, sessionId: frame.sessionId });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
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
      const msg = JSON.stringify({ type: 'loginComplete', cookie: sessionCookie });
      wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(msg);
      });
    }
  }
}
// WebSocket handling
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (!page) return;
      if (msg.type === 'click') {
        await page.mouse.click(msg.x, msg.y);
      } else if (msg.type === 'type') {
        await page.keyboard.type(msg.text);
      } else if (msg.type === 'key') {
        await page.keyboard.press(msg.key);
      } else if (msg.type === 'back') {
        await page.goBack();
      } else if (msg.type === 'status') {
        await checkLogin();
        ws.send(JSON.stringify({ type: 'status', url: currentUrl, loginComplete }));
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });
});
app.get('/', (req, res) => {
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
  <canvas id="screen" width="1280" height="900" onclick="handleClick(event)"></canvas>
  <div id="controls">
    <input type="text" id="textInput" placeholder="Type here and press Enter" onkeypress="handleKey(event)">
    <button onclick="goBack()">Back</button>
  </div>
  <div id="status">Connecting...</div>
</div>
<script>
  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');
  const status = document.getElementById('status');
  let ws = null;

  function connect() {
    ws = new WebSocket('ws://' + window.location.host);
    ws.onopen = () => { status.textContent = 'Connected. Loading browser...'; };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'frame') {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); };
        img.src = 'data:image/jpeg;base64,' + msg.data;
      } else if (msg.type === 'status') {
        status.textContent = 'URL: ' + msg.url;
        if (msg.loginComplete) { window.location.href = '/done'; }
      }
    };
    ws.onclose = () => { status.textContent = 'Disconnected. Reconnecting...'; setTimeout(connect, 2000); };
  }

  function handleClick(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    ws.send(JSON.stringify({ type: 'click', x, y }));
  }

  function handleKey(e) {
    if (e.key === 'Enter') {
      const text = document.getElementById('textInput').value;
      document.getElementById('textInput').value = '';
      ws.send(JSON.stringify({ type: 'type', text }));
    }
  }

  function goBack() {
    ws.send(JSON.stringify({ type: 'back' }));
  }

  setInterval(() => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'status' }));
  }, 2000);

  connect();
</script>
</body></html>`);
});
app.get('/status', async (req, res) => {
  if (!browser) await initBrowser();
  res.json({ url: currentUrl, loginComplete });
});

app.post('/click', async (req, res) => {
  const { x, y } = req.body;
  if (page && x !== undefined && y !== undefined) {
    try {
      await page.mouse.click(x, y);
      await new Promise(r => setTimeout(r, 1000));
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
      await new Promise(r => setTimeout(r, 500));
      await checkLogin();
    } catch (err) { console.error('Type error:', err); }
  }
  res.json({ ok: true });
});

app.post('/back', async (req, res) => {
  if (page) {
    try {
      await page.goBack();
      await new Promise(r => setTimeout(r, 1500));
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
