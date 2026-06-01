/**
 * One-time setup script to get Gmail OAuth2 refresh token.
 * Run: node scripts/setup-gmail-auth.js
 *
 * Prerequisites:
 * 1. In Google Cloud Console, create OAuth2 credentials (Desktop app type)
 * 2. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your environment or .env.local
 * 3. Run this script, visit the URL, authorize, paste the code
 * 4. Copy the refresh_token to your .env.local and Vercel env vars
 */

const { google } = require('googleapis');
const readline = require('readline');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  // drive lets the app upload Gmail attachments into the existing Inbox folder
  // (service accounts can't, having no personal-Drive quota).
  'https://www.googleapis.com/auth/drive',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n=== Gmail OAuth2 Setup ===');
console.log('1. Visit this URL in your browser:');
console.log('\n' + authUrl + '\n');
console.log('2. Authorize the app');
console.log('3. Copy the authorization code and paste it below\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Enter the authorization code: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log('\n=== SUCCESS ===');
    console.log('Add these to your .env.local and Vercel environment variables:\n');
    console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nDone!');
  } catch (err) {
    console.error('Error getting tokens:', err.message);
  }
});
