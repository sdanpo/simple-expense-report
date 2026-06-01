/**
 * Loopback OAuth2 flow (replaces deprecated OOB). Starts a local server,
 * prints an auth URL, captures the redirect, prints + saves the refresh token.
 *
 * Run: node scripts/get-refresh-token.js
 * Then open the printed URL in a browser ON THIS MACHINE.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { google } = require('googleapis');

const envText = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const PORT = 4123;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/drive',
];

const oauth2 = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, REDIRECT);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/?')) {
    res.end('waiting...');
    return;
  }
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err) {
    res.end(`Error: ${err}. You can close this tab.`);
    console.error('AUTH ERROR:', err);
    server.close();
    process.exit(1);
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.end('Success! Refresh token captured. You can close this tab and return to the terminal.');
    console.log('\n=== REFRESH TOKEN ===');
    console.log(tokens.refresh_token);
    console.log('=====================');
    fs.writeFileSync(path.join(__dirname, '..', '.refresh_token'), tokens.refresh_token || '');
    console.log('Saved to .refresh_token');
    server.close();
    process.exit(0);
  } catch (e) {
    res.end('Token exchange failed: ' + e.message);
    console.error('TOKEN EXCHANGE FAILED:', e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\nOpen this URL in your browser (on this machine):\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization on ' + REDIRECT + ' ...');
});
