import { getDriveClient, getUserDriveClient } from './auth';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
}

// The Drive Inbox folder. Hardcoded here (rather than from GOOGLE_DRIVE_INBOX_ID)
// because the original env-configured Inbox was accidentally trashed and replaced by
// this folder, which the phone photo-sync app already writes to. Processed/Ignored
// still come from env. To change the inbox, edit this one value.
export const INBOX_ID = '1Dd8_DsDbm9zHqLWO69Z03WFWKHNPxQyf';

export async function listInboxFiles(): Promise<DriveFile[]> {
  const drive = getDriveClient();
  const res = await drive.files.list({
    q: `'${INBOX_ID}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, webViewLink)',
    pageSize: 100,
  });
  return (res.data.files ?? []) as DriveFile[];
}

export async function downloadFile(fileId: string): Promise<Buffer> {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

export async function moveFile(fileId: string, destinationFolderId: string): Promise<void> {
  const drive = getDriveClient();
  const file = await drive.files.get({ fileId, fields: 'parents' });
  const previousParents = (file.data.parents ?? []).join(',');
  await drive.files.update({
    fileId,
    addParents: destinationFolderId,
    removeParents: previousParents,
    fields: 'id, parents',
  });
}

export async function uploadFileToDrive(
  name: string,
  content: Buffer,
  mimeType: string,
  parentId: string
): Promise<DriveFile> {
  // Upload as the user (Gmail OAuth) — the service account has no storage quota.
  const drive = getUserDriveClient();
  const { Readable } = await import('stream');

  const res = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: Readable.from(content) },
    fields: 'id, name, mimeType, webViewLink',
  });
  return res.data as DriveFile;
}
