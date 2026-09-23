import { BadRequestException } from '@nestjs/common';
import { DocumentsService } from './documents.service';

describe('DocumentsService', () => {
  const prismaMock = {
    $transaction: jest.fn(),
    document: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
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
    });

    prismaMock.document.update.mockResolvedValue({
      id: 'doc-3',
      organizationId: 'org-1',
      filename: 'invoice-2026.pdf',
      status: 'APPROVED',
      documentType: 'INVOICE',
    });

    const result = await service.reviewDocument('doc-3', 'APPROVED', {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(prismaMock.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-3' },
      data: {
        status: 'APPROVED',
      },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
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

  it('extracts invoice fields for review processing', () => {
    const result = service.extractInvoiceData('acme-supplies-invoice-1042.pdf');

    expect(result.vendorName).toBe('Acme Supplies');
    expect(result.invoiceNumber).toBe('1042');
    expect(result.totalAmount).toBeGreaterThan(0);
    expect(result.currency).toBe('USD');
    expect(result.requiresReview).toBe(false);
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
});
