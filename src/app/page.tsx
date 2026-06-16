export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 640, lineHeight: 1.5 }}>
      <h1>Expense Report</h1>
      <p style={{ fontSize: '1.1rem' }}>
        Receipts are captured <strong>automatically</strong>. You don&apos;t need to share,
        forward, or upload anything.
      </p>

      <h2>📱 Photos</h2>
      <p>
        Just take a photo of the receipt with your normal camera — even from the lock screen.
        The app detects it, checks on-device that it looks like a receipt, and files it for you.
        A notification confirms when it&apos;s added.
      </p>

      <h2>📧 Email</h2>
      <p>Receipts that arrive in your email are ingested automatically — nothing to do.</p>

      <h2>See your receipts</h2>
      <p>
        <a href="https://docs.google.com/spreadsheets/d/1dSWFwyXy9wdXMYpjPsrbRCPDVZj8_bI2d4qauCkIAA8">
          Open the expense sheet →
        </a>
      </p>

      <hr style={{ margin: '2rem 0', border: 'none', borderTop: '1px solid #ddd' }} />
      <p style={{ color: '#888', fontSize: '0.85rem' }}>
        No app installed? You can still add a receipt manually by uploading it to the
        Drive <em>Inbox</em> folder, or by emailing it in. The app makes both unnecessary.
      </p>
    </main>
  );
}
