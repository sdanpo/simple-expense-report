import { google } from 'googleapis';

function getServiceAccountAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(raw);
  return new google.auth.JWT(
    credentials.client_email,
    undefined,
    credentials.private_key,
    [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ]
  );
}

export function getDriveClient() {
  return google.drive({ version: 'v3', auth: getServiceAccountAuth() });
}

export function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getServiceAccountAuth() });
}

function getUserOAuth() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oauth2;
}

export function getGmailClient() {
  return google.gmail({ version: 'v1', auth: getUserOAuth() });
}

// Drive client acting AS the user (via Gmail OAuth token). Required for uploads,
// since the service account has no personal-Drive storage quota.
export function getUserDriveClient() {
  return google.drive({ version: 'v3', auth: getUserOAuth() });
}
