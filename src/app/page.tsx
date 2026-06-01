export default function Home() {
  return (
    <main style={{ fontFamily: 'monospace', padding: '2rem' }}>
      <h1>Invoice Automation</h1>
      <p>System is running. Cron jobs execute hourly.</p>
      <ul>
        <li>
          <a href="https://drive.google.com/drive/folders/1EaS0WCSTQutUK7VigyxeTIve8LHTKRFx">
            Google Drive → /Invoices
          </a>
        </li>
        <li>
          <a href="https://docs.google.com/spreadsheets/d/1dSWFwyXy9wdXMYpjPsrbRCPDVZj8_bI2d4qauCkIAA8">
            Google Sheets → Invoice Expenses
          </a>
        </li>
      </ul>
      <h2>To add invoices:</h2>
      <ol>
        <li>Phone: Take photo → Share → Google Drive → Invoices/Inbox</li>
        <li>Email: Forward to dan.porat@gmail.com (auto-ingested hourly)</li>
        <li>Manual: Upload directly to Drive Invoices/Inbox</li>
      </ol>
    </main>
  );
}
