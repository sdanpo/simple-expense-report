import { NextRequest, NextResponse } from 'next/server';
import { getDriveClient } from '@/lib/auth';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/**
 * Admin: trash every file in one or more of the invoice folders. Used to start
 * over with a clean Inbox. Protected by CRON_SECRET.
 *
 * Query: ?folders=inbox,ignored  (default: inbox)
 *   inbox     -> GOOGLE_DRIVE_INBOX_ID
 *   ignored   -> GOOGLE_DRIVE_IGNORED_ID
 *   processed -> GOOGLE_DRIVE_PROCESSED_ID  (only if explicitly requested)
 *
 * Files are moved to the Drive trash (recoverable ~30 days), not hard-deleted.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const folderMap: Record<string, string | undefined> = {
    inbox: process.env.GOOGLE_DRIVE_INBOX_ID,
    ignored: process.env.GOOGLE_DRIVE_IGNORED_ID,
    processed: process.env.GOOGLE_DRIVE_PROCESSED_ID,
  };

  const requested = (req.nextUrl.searchParams.get('folders') || 'inbox')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s in folderMap);

  if (requested.length === 0) {
    return NextResponse.json({ error: 'No valid folders requested' }, { status: 400 });
  }

  try {
    const drive = getDriveClient();
    const trashed: Record<string, number> = {};

    for (const key of requested) {
      const folderId = folderMap[key];
      if (!folderId) continue;
      let count = 0;
      // Page through every file in the folder and trash it.
      let pageToken: string | undefined;
      do {
        const res = await drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id)',
          pageSize: 1000,
          pageToken,
        });
        const files = res.data.files ?? [];
        for (const f of files) {
          await drive.files.update({ fileId: f.id!, requestBody: { trashed: true } });
          count++;
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      trashed[key] = count;
    }

    return NextResponse.json({ trashed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // allow if not set (dev mode)
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}
