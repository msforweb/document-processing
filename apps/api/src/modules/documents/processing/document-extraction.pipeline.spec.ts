import { DocumentExtractionPipeline } from './document-extraction.pipeline';
import { LocalDocumentAiProvider } from './local-document-ai.provider';

describe('DocumentExtractionPipeline', () => {
  const pipeline = new DocumentExtractionPipeline(new LocalDocumentAiProvider());

  it('classifies and normalizes invoice fields into the configured schema', () => {
    const result = pipeline.run(
      'upload.pdf',
      'Invoice\nVendor: Acme Supplies\nInvoice Number: INV-2048\nInvoice Date: 2026-09-01\nDue Date: 2026-09-30\nSubtotal: $1,000.00\nTax: $80.00\nTotal: $1,080.00\nCurrency: usd',
      'UNKNOWN',
    );

    expect(result.documentType).toBe('INVOICE');
    expect(result.classification.confidence).toBeGreaterThan(0.8);
    expect(result.fields.total?.normalizedValue).toBe('1080');
    expect(result.fields.invoice_date?.normalizedValue).toBe('2026-09-01');
    expect(result.missingRequiredFields).toEqual([]);
  });

  it('keeps a declared document type and flags missing required fields for review', () => {
    const result = pipeline.run('scan.pdf', 'Partial invoice text', 'INVOICE');
    expect(result.classification).toEqual({ documentType: 'INVOICE', confidence: 1 });
    expect(result.missingRequiredFields).toEqual(expect.arrayContaining(['vendor_name', 'invoice_number', 'total', 'currency']));
  });

  it('extracts KYC and bank statement fields without an external AI service', () => {
    const kyc = pipeline.run('identity.pdf', 'Identity verification\nFull Name: Jane Doe\nDocument Number: X12345\nDocument Type: Passport\nExpiry Date: 2030-01-01', 'UNKNOWN');
    const bank = pipeline.run('statement.pdf', 'Bank statement\nBank: Example Bank\nAccount Holder: Jane Doe\nAccount Number: 00445566\nClosing Balance: 1200.00 USD', 'UNKNOWN');
    expect(kyc.documentType).toBe('KYC');
    expect(kyc.fields.full_name?.normalizedValue).toBe('Jane Doe');
    expect(bank.documentType).toBe('BANK_STATEMENT');
    expect(bank.fields.account_number?.normalizedValue).toBe('00445566');
  });
});
