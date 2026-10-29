# Veracross Backend (Way 3)

A Node.js + Puppeteer backend that completes Google SSO for Veracross server-side,
capturing the session cookie and returning it to the Android app via deep link.

## ⚠️ Security Warning
This backend receives your Google credentials. Only deploy it on a server you trust.
Do NOT use a public/shared instance.

## Setup
1. Install Node.js 18+.
2. `cd veracross-backend`
3. `npm install`
4. `npm start` (runs on port 3000)

## Deploy
Deploy to any Node.js host (Render, Railway, Fly.io, VPS). Set PORT env var.

## Usage
1. Deploy the backend and note its URL (e.g., https://your-backend.example.com).
2. In the app, tap "Backend login" and enter the backend URL.
3. Enter your Google credentials on the backend's page.
4. The backend logs in to Veracross via headless browser, captures cookies, and redirects back to the app.

## How it works
- The backend uses Puppeteer (headless Chrome) to perform the Google OAuth flow.
- Since the OAuth runs on a real server (not an embedded WebView), Google doesn't block it.
- The captured session cookie is returned to the app via a deep link (veracross://auth?cookie=...).
