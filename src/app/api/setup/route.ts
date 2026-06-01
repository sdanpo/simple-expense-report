import { NextRequest, NextResponse } from 'next/server';
import { ensureSheetHeaders } from '@/lib/sheets';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    await ensureSheetHeaders();
    return NextResponse.json({
      ok: true,
      driveIds: {
        inbox: process.env.GOOGLE_DRIVE_INBOX_ID,
        processed: process.env.GOOGLE_DRIVE_PROCESSED_ID,
        ignored: process.env.GOOGLE_DRIVE_IGNORED_ID,
      },
      sheetsId: process.env.GOOGLE_SHEETS_ID,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
