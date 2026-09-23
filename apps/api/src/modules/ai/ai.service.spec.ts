import { AiService } from './ai.service';

describe('AiService', () => {
  it('recommends human review for a high-risk invoice context', () => {
    const service = new AiService();

    const result = service.buildDocumentInsight({
      filename: 'demo-vendor-invoice-9001.pdf',
      documentType: 'INVOICE',
      status: 'REVIEW_REQUIRED',
      vendorName: 'Demo Vendor',
      invoiceNumber: 'INV-2026-9001',
      totalAmount: 65000,
      currency: 'USD',
      validationFlags: [
        'Vendor name looks like a placeholder or generic test entry',
        'Due date is unusually short for a large invoice',
      ],
      riskScore: 85,
      summary: 'Invoice document requires review. Validation flags: placeholder vendor, short due window.',
    });

    expect(result.riskLevel).toBe('High');
    expect(result.recommendation).toBe('Manual review required');
    expect(result.suggestedAction).toContain('Escalate to reviewer');
    expect(result.explanation).toContain('placeholder');
  });
});
