import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DocumentsService } from './documents.service';

describe('DocumentsService', () => {
  const prismaMock = {
    $transaction: jest.fn(),
    document: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  } as any;

  const storageMock = {
    saveFile: jest.fn(),
  } as any;

  const service = new DocumentsService(prismaMock, storageMock);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores uploaded documents and records an audit log', async () => {
    const uploadedFile = {
      originalname: 'invoice-2026.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('pdf-content'),
    } as Express.Multer.File;

    storageMock.saveFile.mockResolvedValue({
      storagePath: 'storage/organizations/demo-organization/documents/invoice-2026.pdf',
      filename: 'invoice-2026.pdf',
      size: uploadedFile.buffer.byteLength,
      mimeType: uploadedFile.mimetype,
    });

    prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock));
    prismaMock.document.create.mockResolvedValue({
      id: 'doc-1',
      organizationId: 'org-1',
      filename: 'invoice-2026.pdf',
      mimeType: 'application/pdf',
      size: 12,
      storagePath: 'storage/organizations/demo-organization/documents/invoice-2026.pdf',
      status: 'UPLOADED',
      documentType: 'INVOICE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.upload([uploadedFile], {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(storageMock.saveFile).toHaveBeenCalledWith(uploadedFile, 'org-1');
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it('rejects empty uploads', async () => {
    await expect(service.upload([], { id: 'user-1', organizationId: 'org-1', email: 'admin@example.com', role: 'ADMIN' })).rejects.toThrow(BadRequestException);
  });

  it('moves a document through the intake workflow', async () => {
    prismaMock.document.findFirst.mockResolvedValue({
      id: 'doc-2',
      organizationId: 'org-1',
      filename: 'invoice-2026.pdf',
      mimeType: 'application/pdf',
      size: 5120,
      status: 'UPLOADED',
      documentType: 'UNKNOWN',
    });

    prismaMock.document.update.mockResolvedValue({
      id: 'doc-2',
      organizationId: 'org-1',
      filename: 'invoice-2026.pdf',
      mimeType: 'application/pdf',
      size: 5120,
      status: 'PROCESSING',
      documentType: 'INVOICE',
    });

    const result = await service.processDocument('doc-2', {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(prismaMock.document.findFirst).toHaveBeenCalledWith({
      where: { id: 'doc-2', organizationId: 'org-1' },
    });
    expect(prismaMock.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-2' },
        data: expect.objectContaining({
          status: 'PROCESSING',
          documentType: 'INVOICE',
          currency: 'USD',
        }),
      }),
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    expect(result.status).toBe('PROCESSING');
  });

  it('records a human review decision for a document', async () => {
    prismaMock.document.findFirst.mockResolvedValue({
      id: 'doc-3',
      organizationId: 'org-1',
      filename: 'invoice-2026.pdf',
      status: 'PROCESSING',
      documentType: 'INVOICE',
      riskScore: 72,
    });

    prismaMock.document.update.mockResolvedValue({
      id: 'doc-3',
      organizationId: 'org-1',
      filename: 'invoice-2026.pdf',
      status: 'APPROVED',
      documentType: 'INVOICE',
      riskScore: 72,
    });

    const result = await service.reviewDocument('doc-3', 'APPROVED', {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'reviewer@example.com',
      role: 'REVIEWER',
    }, 'Looks valid', 'Vendor matched the approved listing and price was within tolerance');

    expect(prismaMock.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-3' },
      data: {
        status: 'APPROVED',
        reviewNote: 'Looks valid',
        reviewedAt: expect.any(Date),
      },
    });

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'DOCUMENT_REVIEWED',
        metadata: expect.objectContaining({
          decision: 'APPROVED',
          reviewNote: 'Looks valid',
          decisionReason: 'Vendor matched the approved listing and price was within tolerance',
          reviewerEmail: 'reviewer@example.com',
          previousStatus: 'PROCESSING',
          riskScore: 72,
        }),
      }),
    }));
    expect(result.status).toBe('APPROVED');
  });

  it('returns only documents that need review', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'doc-4',
        organizationId: 'org-1',
        filename: 'invoice-2026.pdf',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
      },
    ]);

    const result = await service.getReviewQueue({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(prismaMock.document.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        status: {
          in: ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toHaveLength(1);
  });

  it('returns a paginated review queue when page and limit are requested', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'doc-page-1',
        organizationId: 'org-1',
        filename: 'invoice-2026.pdf',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        createdAt: new Date('2026-09-20T00:00:00.000Z'),
      },
    ]);
    prismaMock.document.count.mockResolvedValue(2);

    const result = await service.getReviewQueue({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'reviewer@example.com',
      role: 'REVIEWER',
    }, {
      status: 'REVIEW_REQUIRED',
      page: 2,
      limit: 1,
    });

    expect(prismaMock.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          status: 'REVIEW_REQUIRED',
        }),
        orderBy: { createdAt: 'desc' },
        take: 1,
        skip: 1,
      }),
    );
    expect(prismaMock.document.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: 'org-1',
        status: 'REVIEW_REQUIRED',
      }),
    });
    expect(result).toMatchObject({
      items: expect.any(Array),
      total: 2,
      page: 2,
      limit: 1,
      totalPages: 2,
    });
  });

  it('filters review queue entries by a text search across filename and vendor', async () => {
    prismaMock.document.findMany.mockResolvedValueOnce([
      {
        id: 'doc-search-1',
        organizationId: 'org-1',
        filename: 'acme-invoice-1042.pdf',
        vendorName: 'Acme Supplies',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        createdAt: new Date('2026-09-20T00:00:00.000Z'),
      },
    ]);

    const result = await service.getReviewQueue({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'reviewer@example.com',
      role: 'REVIEWER',
    }, {
      status: 'REVIEW_REQUIRED',
      search: 'acme',
    });

    expect(prismaMock.document.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        status: 'REVIEW_REQUIRED',
        OR: [
          { filename: { contains: 'acme', mode: 'insensitive' } },
          { vendorName: { contains: 'acme', mode: 'insensitive' } },
          { invoiceNumber: { contains: 'acme', mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('doc-search-1');
  });

  it('reviews multiple queued documents in one action', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'doc-bulk-1',
        organizationId: 'org-1',
        filename: 'invoice-1001.pdf',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        riskScore: 72,
      },
      {
        id: 'doc-bulk-2',
        organizationId: 'org-1',
        filename: 'invoice-1002.pdf',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        riskScore: 66,
      },
    ]);

    prismaMock.document.updateMany.mockResolvedValue({ count: 2 });

    const result = await service.bulkReviewDocuments(
      ['doc-bulk-1', 'doc-bulk-2'],
      'APPROVED',
      {
        id: 'user-1',
        organizationId: 'org-1',
        email: 'reviewer@example.com',
        role: 'REVIEWER',
      },
      'Bulk approved',
    );

    expect(prismaMock.document.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['doc-bulk-1', 'doc-bulk-2'] },
        organizationId: 'org-1',
      },
      data: {
        status: 'APPROVED',
        reviewNote: 'Bulk approved',
        reviewedAt: expect.any(Date),
      },
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('doc-bulk-1');
  });

  it('exports the filtered review queue as CSV', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'doc-export-1',
        organizationId: 'org-1',
        filename: 'acme-invoice-1042.pdf',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        vendorName: 'Acme Supplies',
        invoiceNumber: 'INV-1042',
        totalAmount: 2543.8,
        currency: 'USD',
        createdAt: new Date('2026-09-20T00:00:00.000Z'),
      },
    ]);

    const result = await service.exportReviewQueue({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'reviewer@example.com',
      role: 'REVIEWER',
    }, {
      status: 'REVIEW_REQUIRED',
      search: 'acme',
    });

    expect(result).toContain('filename');
    expect(result).toContain('acme-invoice-1042.pdf');
    expect(result).toContain('Acme Supplies');
    expect(result).toContain('INV-1042');
  });

  it('filters the review queue to high-risk invoice work', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'doc-low-risk',
        organizationId: 'org-1',
        filename: 'invoice-1001.pdf',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        vendorName: 'Acme Supply',
        invoiceNumber: '1001',
        totalAmount: 950,
        currency: 'USD',
        createdAt: new Date('2026-09-20T00:00:00.000Z'),
      },
      {
        id: 'doc-high-risk',
        organizationId: 'org-1',
        filename: 'invoice-9999.pdf',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        vendorName: '',
        invoiceNumber: 'N/A',
        totalAmount: 0,
        currency: 'USD',
        createdAt: new Date('2026-09-22T00:00:00.000Z'),
      },
    ]);

    const result = await service.getReviewQueue({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    }, {
      status: 'REVIEW_REQUIRED',
      documentType: 'INVOICE',
      onlyHighRisk: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('doc-high-risk');
    expect(result[0]?.riskScore).toBeGreaterThanOrEqual(60);
  });

  it('returns audit history for a selected document', async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([
      {
        id: 'audit-2',
        action: 'DOCUMENT_REVIEWED',
        metadata: { decision: 'APPROVED', reviewNote: 'Looks valid' },
        createdAt: new Date('2026-09-23T09:05:00.000Z'),
      },
      {
        id: 'audit-1',
        action: 'DOCUMENT_PROCESSED',
        metadata: { status: 'PROCESSING' },
        createdAt: new Date('2026-09-23T09:00:00.000Z'),
      },
    ]);

    const result = await service.getDocumentAuditTrail('doc-3', {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        documentId: 'doc-3',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.action).toBe('DOCUMENT_REVIEWED');
  });

  it('exports the selected document audit trail as CSV', async () => {
    prismaMock.document.findFirst.mockResolvedValue({
      id: 'doc-3',
      organizationId: 'org-1',
      filename: 'invoice-2026.pdf',
      status: 'REVIEW_REQUIRED',
    });

    prismaMock.auditLog.findMany.mockResolvedValue([
      {
        id: 'audit-2',
        action: 'DOCUMENT_REVIEWED',
        metadata: { decision: 'APPROVED', reviewNote: 'Looks valid' },
        createdAt: new Date('2026-09-23T09:05:00.000Z'),
      },
      {
        id: 'audit-1',
        action: 'DOCUMENT_PROCESSED',
        metadata: { status: 'PROCESSING' },
        createdAt: new Date('2026-09-23T09:00:00.000Z'),
      },
    ]);

    const result = await service.exportDocumentAuditTrail('doc-3', {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(result).toContain('action');
    expect(result).toContain('DOCUMENT_REVIEWED');
    expect(result).toContain('Looks valid');
  });

  it('returns a reviewer dashboard summary', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      { id: 'd1', organizationId: 'org-1', status: 'APPROVED', documentType: 'INVOICE', vendorName: 'Acme', invoiceNumber: '1001', totalAmount: 100, currency: 'USD', createdAt: new Date() },
      { id: 'd2', organizationId: 'org-1', status: 'REVIEW_REQUIRED', documentType: 'INVOICE', vendorName: '', invoiceNumber: 'N/A', totalAmount: 0, currency: 'USD', createdAt: new Date() },
      { id: 'd3', organizationId: 'org-1', status: 'PROCESSING', documentType: 'INVOICE', vendorName: 'Acme', invoiceNumber: '1003', totalAmount: 200, currency: 'USD', createdAt: new Date() },
      { id: 'd4', organizationId: 'org-1', status: 'REJECTED', documentType: 'INVOICE', vendorName: 'Acme', invoiceNumber: '1004', totalAmount: 300, currency: 'USD', createdAt: new Date() },
    ]);

    const result = await service.getDashboardSummary({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(result.totalDocuments).toBe(4);
    expect(result.reviewCount).toBe(2);
    expect(result.approvalRate).toBe(25);
    expect(result.highRiskCount).toBe(1);
    expect(result.typeBreakdown.INVOICE).toBe(4);
  });

  it('returns operational review analytics for risk and queue aging', async () => {
    const now = new Date();
    prismaMock.document.findMany.mockResolvedValue([
      { id: 'a1', organizationId: 'org-1', status: 'APPROVED', documentType: 'INVOICE', vendorName: 'Acme', invoiceNumber: '1001', totalAmount: 100, currency: 'USD', createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) },
      { id: 'a2', organizationId: 'org-1', status: 'REVIEW_REQUIRED', documentType: 'INVOICE', vendorName: '', invoiceNumber: 'N/A', totalAmount: 0, currency: 'USD', createdAt: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000) },
      { id: 'a3', organizationId: 'org-1', status: 'PROCESSING', documentType: 'BANK_STATEMENT', vendorName: 'Metro Bank', invoiceNumber: '2001', totalAmount: 3000, currency: 'USD', createdAt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000) },
    ]);

    const result = await service.getReviewAnalytics({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    }, 7);

    expect(result.totalDocuments).toBe(3);
    expect(result.approvalRate).toBe(33);
    expect(result.riskBreakdown.high).toBe(1);
    expect(result.agingSummary.reviewRequiredCount).toBe(1);
    expect(result.dailyTrend).toHaveLength(7);
    expect(result.dailyTrend[0]).toHaveProperty('date');
  });

  it('flags policy exceptions for duplicate invoice patterns in analytics', async () => {
    const now = new Date();
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'policy-1',
        organizationId: 'org-1',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        vendorName: 'Northwind',
        invoiceNumber: 'INV-2001',
        totalAmount: 12500,
        currency: 'USD',
        createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      },
      {
        id: 'policy-2',
        organizationId: 'org-1',
        status: 'PROCESSING',
        documentType: 'INVOICE',
        vendorName: 'Northwind',
        invoiceNumber: 'INV-2001',
        totalAmount: 13250,
        currency: 'USD',
        createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      },
      {
        id: 'policy-3',
        organizationId: 'org-1',
        status: 'APPROVED',
        documentType: 'INVOICE',
        vendorName: 'Northwind',
        invoiceNumber: 'INV-2003',
        totalAmount: 9800,
        currency: 'USD',
        createdAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
      },
    ]);

    const result = await service.getReviewAnalytics({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    }, 7);

    expect(result.policyExceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'Duplicate invoice pattern',
          vendor: 'Northwind',
          severity: 'high',
        }),
      ]),
    );
  });

  it('exports review analytics as a CSV report', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'analytics-1',
        organizationId: 'org-1',
        status: 'APPROVED',
        documentType: 'INVOICE',
        vendorName: 'Northwind',
        invoiceNumber: 'INV-2001',
        totalAmount: 1200,
        currency: 'USD',
        createdAt: new Date('2026-09-20T00:00:00.000Z'),
      },
      {
        id: 'analytics-2',
        organizationId: 'org-1',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        vendorName: 'Northwind',
        invoiceNumber: 'INV-2001',
        totalAmount: 1400,
        currency: 'USD',
        createdAt: new Date('2026-09-19T00:00:00.000Z'),
      },
    ]);

    const result = await service.exportReviewAnalytics({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    }, 7);

    expect(result).toContain('approvalRate');
    expect(result).toContain('Northwind');
    expect(result).toContain('Duplicate invoice pattern');
  });

  it('prioritizes high-risk reviews first', async () => {
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'doc-low-risk',
        organizationId: 'org-1',
        filename: 'vendor-invoice-1001.pdf',
        status: 'PROCESSING',
        documentType: 'INVOICE',
        vendorName: 'Acme Supply',
        invoiceNumber: '1001',
        totalAmount: 1250,
        currency: 'USD',
        createdAt: new Date('2026-09-21T00:00:00.000Z'),
      },
      {
        id: 'doc-high-risk',
        organizationId: 'org-1',
        filename: 'invoice-unknown.pdf',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        vendorName: '',
        invoiceNumber: 'N/A',
        totalAmount: 0,
        currency: 'USD',
        createdAt: new Date('2026-09-22T00:00:00.000Z'),
      },
    ]);

    const result = await service.getReviewQueue({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('doc-high-risk');
    expect(result[0]?.riskScore ?? 0).toBeGreaterThan(result[1]?.riskScore ?? 0);
  });

  it('creates a human-readable summary for a selected document', async () => {
    prismaMock.document.findFirst.mockResolvedValue({
      id: 'doc-5',
      organizationId: 'org-1',
      filename: 'invoice-2026.pdf',
      status: 'REVIEW_REQUIRED',
      documentType: 'INVOICE',
      size: 2048,
      createdAt: new Date('2026-09-23T10:00:00.000Z'),
      vendorName: '',
      invoiceNumber: 'N/A',
      totalAmount: 0,
      currency: 'USD',
    });

    const result = await service.summarizeDocument('doc-5', {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(prismaMock.document.findFirst).toHaveBeenCalledWith({
      where: { id: 'doc-5', organizationId: 'org-1' },
    });
    expect(result.summary).toContain('Invoice');
    expect(result.summary).toContain('Requires review');
    expect(result.validationFlags).toContain('Missing vendor name');
    expect(result.riskScore).toBeGreaterThan(0);
  });

  it('extracts invoice text from a real PDF document before parsing fields', async () => {
    const pdfBuffer = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 76 >>
stream
BT
/F1 18 Tf
72 72 Td
(ACME SUPPLIES) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Root 1 0 R /Size 5 >>
%%EOF`);

    const filePath = path.resolve(process.cwd(), 'tmp-pdf-invoice.pdf');
    await fs.writeFile(filePath, pdfBuffer);

    try {
      const extractedText = await (service as any).readDocumentTextHint(filePath);
      expect(extractedText).toContain('ACME SUPPLIES');

      const result = service.extractInvoiceData('tmp-pdf-invoice.pdf', extractedText);
      expect(result.vendorName).toBe('Acme Supplies');
    } finally {
      await fs.unlink(filePath).catch(() => undefined);
    }
  });

  it('decodes hex-encoded PDF text streams for vendor extraction', async () => {
    const pdfBuffer = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 48 >>
stream
BT
/F1 18 Tf
72 72 Td
<41434D4520535550504C494553> Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Root 1 0 R /Size 5 >>
%%EOF`);

    const filePath = path.resolve(process.cwd(), 'tmp-pdf-hex-invoice.pdf');
    await fs.writeFile(filePath, pdfBuffer);

    try {
      const extractedText = await (service as any).readDocumentTextHint(filePath);
      const result = service.extractInvoiceData('tmp-pdf-hex-invoice.pdf', extractedText);

      expect(typeof extractedText).toBe('string');
      expect(result.vendorName).toBe('Acme Supplies');
    } finally {
      await fs.unlink(filePath).catch(() => undefined);
    }
  });

  it('uses OCR fallback for scanned images before parsing invoice fields', async () => {
    const imagePath = path.resolve(process.cwd(), 'tmp-scan.png');
    await fs.writeFile(imagePath, Buffer.from('fake-png-content'));
    const ocrSpy = jest.spyOn(service as any, 'extractImageTextWithOcr').mockResolvedValue('ACME SUPPLIES Invoice # INV-2048');

    try {
      const result = await (service as any).readDocumentTextHint(imagePath);
      expect(ocrSpy).toHaveBeenCalledWith(imagePath);
      expect(result).toContain('ACME SUPPLIES');
      expect(result).toContain('INV-2048');
    } finally {
      ocrSpy.mockRestore();
      await fs.unlink(imagePath).catch(() => undefined);
    }
  });

  it('uses OCR fallback when a scanned PDF has no embedded text', async () => {
    const pdfPath = path.resolve(process.cwd(), 'tmp-scanned-invoice.pdf');
    await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF'));
    const ocrSpy = jest.spyOn(service as any, 'extractImageTextWithOcr').mockResolvedValue('ACME SUPPLIES Invoice # INV-3030');

    try {
      const result = await (service as any).readDocumentTextHint(pdfPath);
      expect(ocrSpy).toHaveBeenCalledWith(pdfPath);
      expect(result).toContain('ACME SUPPLIES');
      expect(result).toContain('INV-3030');
    } finally {
      ocrSpy.mockRestore();
      await fs.unlink(pdfPath).catch(() => undefined);
    }
  });

  it('extracts invoice fields for review processing', () => {
    const result = service.extractInvoiceData('acme-supplies-invoice-1042.pdf');

    expect(result.vendorName).toBe('Acme Supplies');
    expect(result.invoiceNumber).toBe('1042');
    expect(result.totalAmount).toBeGreaterThan(0);
    expect(result.currency).toBe('USD');
    expect(result.requiresReview).toBe(false);
  });

  it('extracts invoice fields from document content instead of only filename hints', () => {
    const result = service.extractInvoiceData(
      'receipt.pdf',
      'ACME SUPPLIES\nInvoice # INV-2048\nDate: 2026-09-15\nDue: 2026-09-30\nTotal USD 2543.80',
    );

    expect(result.vendorName).toBe('Acme Supplies');
    expect(result.invoiceNumber).toBe('INV-2048');
    expect(result.totalAmount).toBe(2543.8);
    expect(result.currency).toBe('USD');
    expect(result.requiresReview).toBe(false);
  });

  it('flags duplicate invoice numbers across the same organization as a compliance risk', async () => {
    prismaMock.document.findFirst.mockResolvedValue({
      id: 'doc-dup-new',
      organizationId: 'org-1',
      filename: 'acme-invoice-1042.pdf',
      mimeType: 'application/pdf',
      size: 4096,
      status: 'UPLOADED',
      documentType: 'UNKNOWN',
      vendorName: null,
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      totalAmount: null,
      currency: null,
      storagePath: 'storage/organizations/org-1/documents/acme-invoice-1042.pdf',
    });

    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'doc-dup-old',
        organizationId: 'org-1',
        filename: 'acme-invoice-1042.pdf',
        status: 'APPROVED',
        documentType: 'INVOICE',
        vendorName: 'Acme Supplies',
        invoiceNumber: '1042',
        totalAmount: 1500,
        currency: 'USD',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);

    prismaMock.document.update.mockResolvedValue({
      id: 'doc-dup-new',
      organizationId: 'org-1',
      filename: 'acme-invoice-1042.pdf',
      mimeType: 'application/pdf',
      size: 4096,
      status: 'REVIEW_REQUIRED',
      documentType: 'INVOICE',
      vendorName: 'Acme Supplies',
      invoiceNumber: '1042',
      totalAmount: 1500,
      currency: 'USD',
      extractedAt: new Date(),
    });

    const result = await service.processDocument('doc-dup-new', {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(prismaMock.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          documentType: 'INVOICE',
        }),
      }),
    );
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'DOCUMENT_VALIDATION_FLAGGED',
        metadata: expect.objectContaining({
          flags: expect.arrayContaining(['Duplicate invoice detected for the same vendor']),
        }),
      }),
    }));
  });

  it('flags incomplete invoice metadata for review', () => {
    const result = service.validateInvoice({
      vendorName: '',
      invoiceNumber: '',
      totalAmount: 0,
      currency: 'USD',
    });

    expect(result.requiresReview).toBe(true);
    expect(result.flags).toContain('Missing vendor name');
    expect(result.flags).toContain('Missing invoice number');
    expect(result.flags).toContain('Total amount is missing or invalid');
  });

  it('flags suspicious invoice dates and unusually large amounts for review', () => {
    const invoiceDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const dueDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const result = service.validateInvoice({
      vendorName: 'Acme Supplies',
      invoiceNumber: 'INV-2026-9999',
      invoiceDate,
      dueDate,
      totalAmount: 150000,
      currency: 'USD',
    });

    expect(result.requiresReview).toBe(true);
    expect(result.flags).toContain('Invoice date is in the future');
    expect(result.flags).toContain('Due date is before invoice date');
    expect(result.flags).toContain('Large invoice amount may require manual review');
    expect(result.riskScore).toBeGreaterThanOrEqual(60);
  });

  it('flags placeholder vendor names and short payment windows as compliance risks', () => {
    const invoiceDate = new Date(Date.now());
    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const result = service.validateInvoice({
      vendorName: 'Demo Vendor',
      invoiceNumber: 'INV-2026-9001',
      invoiceDate,
      dueDate,
      totalAmount: 65000,
      currency: 'USD',
    });

    expect(result.requiresReview).toBe(true);
    expect(result.flags).toContain('Vendor name looks like a placeholder or generic test entry');
    expect(result.flags).toContain('Due date is unusually short for a large invoice');
    expect(result.riskScore).toBeGreaterThanOrEqual(60);
  });
});
