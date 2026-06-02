export interface InvoiceData {
  vendor: string | null;
  invoice_date: string | null;
  total_amount: number | null;
  currency: string | null;
  tax_amount: number | null;
  invoice_number: string | null;
  confidence: number;
}

export interface ClassificationResult {
  is_invoice: boolean;
  confidence: number;
}

/** Combined classify + extract result — one Gemini call per file (quota is scarce). */
export interface DocumentAnalysis extends InvoiceData {
  is_invoice: boolean;
}

export type InvoiceStatus = 'Approved' | 'Needs Review' | 'Ignored';

export interface SheetRow {
  vendor: string;
  invoice_date: string;
  total_amount: string;
  currency: string;
  tax_amount: string;
  invoice_number: string;
  confidence: string;
  status: InvoiceStatus;
  file_name: string;
  drive_link: string;
  processed_at: string;
}
