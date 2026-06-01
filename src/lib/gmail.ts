import { getGmailClient } from './auth';
import { uploadFileToDrive } from './drive';

const INVOICE_KEYWORDS = [
  'invoice',
  'receipt',
  'חשבונית',
  'קבלה',
  'bill',
  'payment',
  'order confirmation',
  'פירוט חיוב',
  'tax invoice',
];

const ATTACHMENT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/pdf',
]);

// Returns number of files ingested
export async function ingestGmailAttachments(): Promise<number> {
  const gmail = getGmailClient();
  const inboxId = process.env.GOOGLE_DRIVE_INBOX_ID!;
  let ingested = 0;

  // Search unprocessed emails with attachments (not yet labeled "invoice-processed")
  const query = `has:attachment -label:invoice-processed newer_than:30d`;
  const threads = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 50,
  });

  const messages = threads.data.messages ?? [];
  if (messages.length === 0) return 0;

  // Ensure label exists
  const labelId = await ensureLabel(gmail, 'invoice-processed');

  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'full',
      });

      const parts = full.data.payload?.parts ?? [];
      const subject = getHeader(full.data.payload?.headers ?? [], 'Subject') ?? 'unknown';
      const date = getHeader(full.data.payload?.headers ?? [], 'Date') ?? '';

      for (const part of flattenParts(parts)) {
        if (!part.filename || !part.body?.attachmentId) continue;
        if (!ATTACHMENT_MIME_TYPES.has((part.mimeType ?? '').toLowerCase())) continue;

        const attachment = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: msg.id!,
          id: part.body.attachmentId,
        });

        const data = attachment.data.data;
        if (!data) continue;

        // Gmail uses URL-safe base64
        const buffer = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        const safeName = sanitizeFileName(`${date.slice(0, 10)}_${subject}_${part.filename}`);

        await uploadFileToDrive(safeName, buffer, part.mimeType ?? 'application/octet-stream', inboxId);
        ingested++;
      }

      // Mark as processed regardless of attachments found
      await gmail.users.messages.modify({
        userId: 'me',
        id: msg.id!,
        requestBody: { addLabelIds: [labelId] },
      });
    } catch (err) {
      console.error(`Failed to process message ${msg.id}:`, err);
    }
  }

  return ingested;
}

function flattenParts(parts: any[]): any[] {
  const result: any[] = [];
  for (const part of parts) {
    if (part.parts) result.push(...flattenParts(part.parts));
    else result.push(part);
  }
  return result;
}

function getHeader(headers: { name?: string | null; value?: string | null }[], name: string): string | null {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

async function ensureLabel(gmail: any, name: string): Promise<string> {
  const existing = await gmail.users.labels.list({ userId: 'me' });
  const found = existing.data.labels?.find((l: any) => l.name === name);
  if (found) return found.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  return created.data.id;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\-֐-׿ ]/g, '_').slice(0, 200);
}
