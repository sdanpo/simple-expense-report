/**
 * One-time setup to get a Gmail+Drive OAuth2 refresh token for the backend.
 *
 * The backend uses this token to (a) read labeled Gmail and (b) upload receipt
 * images into your Drive /Invoices/Processed folder "as you" (the service account
 * has no personal-Drive quota).
 *
 * Run:
 *   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node scripts/setup-gmail-auth.js
 *
 * Prerequisites:
 *   1. A Google Cloud OAuth 2.0 Client of type "Desktop app" (loopback is allowed).
 *   2. Its client id + secret in GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET.
 *   3. Run, open the printed URL, authorize. The code is captured automatically via
 *      a local http://localhost callback (Google retired the old "oob" flow).
 *   4. Copy the printed GMAIL_REFRESH_TOKEN into Vercel (Production) env vars, then
 *      redeploy.
 */

const http = require('http');
const { google } = require('googleapis');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first.');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  // Drive: upload receipt images / Gmail attachments into the Drive folders as you.
  'https://www.googleapis.com/auth/drive',
];

const server = http.createServer();
server.listen(0, () => {
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);

  server.on('request', async (req, res) => {
    const code = new URL(req.url, redirectUri).searchParams.get('code');
    if (!code) {
      res.writeHead(400);
      res.end('No authorization code received.');
      return;
    }
    res.end('Authorized! Return to your terminal — you can close this tab.');
    try {
      const { tokens } = await oauth2Client.getToken(code);
      console.log('\n=== SUCCESS — add this to Vercel (Production) env, then redeploy ===\n');
      console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
      if (!tokens.refresh_token) {
        console.log('\n(No refresh_token returned — revoke prior access at ' +
          'https://myaccount.google.com/permissions and re-run.)');
      }
      console.log('');
    } catch (err) {
      console.error('Token exchange failed:', err.message);
    } finally {
      server.close();
    }
  });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force a refresh_token even if previously granted
  });

  console.log('\n=== Gmail + Drive OAuth setup ===');
  console.log('1. Open this URL in your browser and authorize:\n');
  console.log(authUrl + '\n');
  console.log('2. After you approve, this script captures the code automatically and');
  console.log('   prints GMAIL_REFRESH_TOKEN below.\n');
});
