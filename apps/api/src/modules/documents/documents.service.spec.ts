import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DocumentsService } from './documents.service';

describe('DocumentsService', () => {
  const prismaMock = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    document: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findMany: jest.fn() },
    reviewAssignment: { findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    notification: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    vendorRiskProfile: { upsert: jest.fn(), findMany: jest.fn() },
    processingJob: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    documentClassification: { upsert: jest.fn() },
    extractedField: { upsert: jest.fn(), findMany: jest.fn() },
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

  it('persists a processing job and queues it for background execution', async () => {
    const queueMock = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const queuedService = new DocumentsService(prismaMock, storageMock, queueMock as any);
    prismaMock.document.findFirst.mockResolvedValue({ id: 'queue-doc-1', organizationId: 'org-1', status: 'UPLOADED' });
    prismaMock.processingJob.findFirst.mockResolvedValue(null);
    prismaMock.processingJob.create.mockResolvedValue({ id: 'queue-job-1', status: 'QUEUED', progress: 0 });

    const result = await queuedService.enqueueDocumentProcessing('queue-doc-1', {
      id: 'operator-1', organizationId: 'org-1', email: 'operator@example.com', role: 'OPERATOR',
    });

    expect(queueMock.enqueue).toHaveBeenCalledWith(expect.objectContaining({ processingJobId: 'queue-job-1', documentId: 'queue-doc-1' }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PROCESSING_JOB_QUEUED' }) }));
    expect(result.status).toBe('QUEUED');
  });

  it('returns the latest processing state only for documents in the requesting organization', async () => {
    prismaMock.document.findFirst.mockResolvedValue({ id: 'queue-doc-2', status: 'PROCESSING' });
    prismaMock.processingJob.findFirst.mockResolvedValue({ id: 'queue-job-2', status: 'ACTIVE', currentStep: 'TEXT_EXTRACTION', progress: 20 });

    const result = await service.getDocumentProcessingStatus('queue-doc-2', {
      id: 'operator-1', organizationId: 'org-1', email: 'operator@example.com', role: 'OPERATOR',
    });

    expect(prismaMock.document.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'queue-doc-2', organizationId: 'org-1' } }));
    expect(result.processingJob?.progress).toBe(20);
  });

  it('scores vendors for repeated risky invoices and possible invoice splitting', async () => {
    const now = Date.now();
    prismaMock.document.findMany.mockResolvedValue([
      { id: 'risk-1', vendorName: 'Northwind', invoiceNumber: 'INV-1', documentType: 'INVOICE', totalAmount: 24000, currency: 'USD', status: 'REVIEW_REQUIRED', createdAt: new Date(now) },
      { id: 'risk-2', vendorName: 'Northwind', invoiceNumber: 'INV-2', documentType: 'INVOICE', totalAmount: 26000, currency: 'USD', status: 'REVIEW_REQUIRED', createdAt: new Date(now + 1000) },
      { id: 'risk-3', vendorName: 'Northwind', invoiceNumber: 'INV-3', documentType: 'INVOICE', totalAmount: 12000, currency: 'USD', status: 'APPROVED', createdAt: new Date(now + 2000) },
    ]);
    prismaMock.vendorRiskProfile.upsert.mockResolvedValue({ vendorName: 'Northwind', score: 80 });
    prismaMock.vendorRiskProfile.findMany.mockResolvedValue([{ vendorName: 'Northwind', score: 80 }]);

    await service.recalculateVendorRiskProfiles({ id: 'admin-1', organizationId: 'org-1', email: 'admin@example.com', role: 'ADMIN' });

    expect(prismaMock.vendorRiskProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ vendorName: 'Northwind', currency: 'USD', signals: expect.arrayContaining([expect.stringContaining('near-threshold')]) }),
    }));
  });

  it('creates idempotent escalation notifications for tenant administrators', async () => {
    jest.spyOn(service, 'getEscalationSummary').mockResolvedValue([{
      id: 'document-alert', documentId: 'document-alert', type: 'SLA_ESCALATION', severity: 'high',
      vendor: 'Northwind', reviewer: 'Maya Chen', lane: 'FINANCE_REVIEW', documentType: 'INVOICE',
      status: 'REVIEW_REQUIRED', daysOpen: 4, detail: 'Northwind review is overdue.',
    }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'admin-1' }]);
    prismaMock.document.findMany.mockResolvedValue([{ id: 'document-alert', assignedReviewerId: null }]);
    prismaMock.notification.findUnique.mockResolvedValue(null);

    await service.evaluateEscalations({ id: 'admin-1', organizationId: 'org-1', email: 'admin@example.com', role: 'ADMIN' });

    expect(prismaMock.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'admin-1', documentId: 'document-alert', type: 'SLA_ESCALATION' }),
    }));
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId: 'org-1', type: 'SLA_ESCALATION', documentId: { notIn: ['document-alert'] } }),
    }));
  });

  it('assigns pending work to the least-loaded organization reviewer and audits it', async () => {
    prismaMock.document.findFirst.mockResolvedValue({ id: 'assign-1', organizationId: 'org-1', status: 'REVIEW_REQUIRED' });
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'reviewer-1', name: 'A Reviewer', email: 'a@example.com' },
      { id: 'reviewer-2', name: 'B Reviewer', email: 'b@example.com' },
    ]);
    prismaMock.reviewAssignment.findMany.mockResolvedValue([{ reviewerId: 'reviewer-1' }]);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.document.update.mockResolvedValue({ id: 'assign-1', assignedReviewerId: 'reviewer-2' });

    const result = await service.assignReviewer('assign-1', {
      id: 'admin-1', organizationId: 'org-1', email: 'admin@example.com', role: 'ADMIN',
    });

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.document.update).toHaveBeenCalledWith({ where: { id: 'assign-1' }, data: { assignedReviewerId: 'reviewer-2' } });
    expect(prismaMock.reviewAssignment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reviewerId: 'reviewer-2', status: 'ACTIVE' }) }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'DOCUMENT_REVIEWER_ASSIGNED' }) }));
    expect(result.assignedReviewer.id).toBe('reviewer-2');
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
          status: 'REVIEW_REQUIRED',
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
      include: { assignedReviewer: { select: { id: true, name: true, email: true } }, fraudAssessment: true },
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
      include: { assignedReviewer: { select: { id: true, name: true, email: true } }, fraudAssessment: true },
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

  it('flags abnormal invoice spikes for a vendor as a high-risk compliance signal', async () => {
    const now = new Date();
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'spike-1',
        organizationId: 'org-1',
        status: 'APPROVED',
        documentType: 'INVOICE',
        vendorName: 'Northwind',
        invoiceNumber: 'INV-3001',
        totalAmount: 1200,
        currency: 'USD',
        createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      },
      {
        id: 'spike-2',
        organizationId: 'org-1',
        status: 'PROCESSING',
        documentType: 'INVOICE',
        vendorName: 'Northwind',
        invoiceNumber: 'INV-3002',
        totalAmount: 1500,
        currency: 'USD',
        createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      },
      {
        id: 'spike-3',
        organizationId: 'org-1',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        vendorName: 'Northwind',
        invoiceNumber: 'INV-3003',
        totalAmount: 54000,
        currency: 'USD',
        createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
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
          type: 'Amount spike risk',
          vendor: 'Northwind',
          severity: 'high',
        }),
      ]),
    );
  });

  it('escalates overdue high-risk invoices to the finance team', async () => {
    const now = new Date();
    prismaMock.document.findMany.mockResolvedValue([
      {
        id: 'escalation-1',
        organizationId: 'org-1',
        status: 'REVIEW_REQUIRED',
        documentType: 'INVOICE',
        vendorName: 'Northwind',
        invoiceNumber: 'INV-5001',
        totalAmount: 54000,
        currency: 'USD',
        createdAt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000),
      },
      {
        id: 'escalation-2',
        organizationId: 'org-1',
        status: 'PROCESSING',
        documentType: 'INVOICE',
        vendorName: 'Bluefin',
        invoiceNumber: 'INV-5002',
        totalAmount: 4400,
        currency: 'USD',
        createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      },
    ]);

    const result = await service.getEscalationSummary({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    } as any);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'SLA_ESCALATION',
        severity: 'high',
        vendor: 'Northwind',
        reviewer: 'Maya Chen',
      }),
    ]));
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
      include: {
        assignedReviewer: { select: { id: true, name: true, email: true } },
        classification: true,
        extractedFields: { orderBy: { fieldName: 'asc' } },
        fraudAssessment: true,
      },
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

  it('ranks structured invoice OCR above longer noisy output', () => {
    const scoreOcrText = (service as any).scoreOcrText.bind(service);
    const structuredInvoice = 'ACME SUPPLIES INVOICE INV-2048 Date 2026-09-18 Total USD 1,240.50';
    const noisyOutput = '######## lllllll 00000 ///// @@@@ xxxxx zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

    expect(scoreOcrText(structuredInvoice)).toBeGreaterThan(scoreOcrText(noisyOutput));
  });

  it('preprocesses images and compares multiple Tesseract page segmentation modes', async () => {
    const imagePath = path.resolve(process.cwd(), 'tmp-enhanced-scan.png');
    await fs.writeFile(imagePath, Buffer.from('fake-png-content'));
    const previousProcessor = process.env.OCR_IMAGE_PROCESSOR_PATH;
    const previousPreprocessing = process.env.OCR_PREPROCESSING_ENABLED;
    process.env.OCR_IMAGE_PROCESSOR_PATH = 'mock-image-processor';
    process.env.OCR_PREPROCESSING_ENABLED = 'true';
    const commandSpy = jest.spyOn(service as any, 'runOcrCommand').mockImplementation(((binary: string, args: string[]) => {
      if (binary === 'mock-image-processor') return Buffer.alloc(0);
      return args.includes('11') ? 'Vendor INV-2048 total 1,200 USD' : 'Vendor INV-2048';
    }) as any);

    try {
      const result = await (service as any).extractImageTextWithOcr(imagePath);
      expect(result).toContain('total 1,200 USD');
      expect(commandSpy).toHaveBeenCalledWith('mock-image-processor', expect.arrayContaining(['-normalize', '-contrast-stretch', '-sharpen']), expect.any(Object));
      expect(commandSpy.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('--psm') && args.includes('6'))).toBe(true);
      expect(commandSpy.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('--psm') && args.includes('11'))).toBe(true);
    } finally {
      commandSpy.mockRestore();
      if (previousProcessor === undefined) delete process.env.OCR_IMAGE_PROCESSOR_PATH;
      else process.env.OCR_IMAGE_PROCESSOR_PATH = previousProcessor;
      if (previousPreprocessing === undefined) delete process.env.OCR_PREPROCESSING_ENABLED;
      else process.env.OCR_PREPROCESSING_ENABLED = previousPreprocessing;
      await fs.unlink(imagePath).catch(() => undefined);
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

  it('routes high-risk invoice work to the finance review lane and recommends the right reviewer', () => {
    const financeLane = (service as any).getRecommendedReviewLane({ documentType: 'INVOICE', totalAmount: 75000 }, 86);
    const financeReviewer = (service as any).getRecommendedReviewer({ documentType: 'INVOICE', totalAmount: 75000 }, 86);
    const bankingLane = (service as any).getRecommendedReviewLane({ documentType: 'BANK_STATEMENT' }, 24);
    const bankingReviewer = (service as any).getRecommendedReviewer({ documentType: 'BANK_STATEMENT' }, 24);

    expect(financeLane).toBe('FINANCE_REVIEW');
    expect(financeReviewer).toBe('Maya Chen');
    expect(bankingLane).toBe('BANKING_REVIEW');
    expect(bankingReviewer).toBe('Nina Patel');
  });

  it('classifies a generic filename based on extracted document content', async () => {
    prismaMock.document.findFirst.mockResolvedValue({
      id: 'doc-classify-text',
      organizationId: 'org-1',
      filename: 'upload-2026.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      status: 'UPLOADED',
      documentType: 'UNKNOWN',
      vendorName: null,
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      totalAmount: null,
      currency: null,
      storagePath: 'storage/organizations/org-1/documents/upload-2026.pdf',
    });

    const readSpy = jest.spyOn(service as any, 'readDocumentTextHint').mockResolvedValue('BANK OF AMERICA STATEMENT Account Ending 1234');
    prismaMock.document.update.mockResolvedValue({
      id: 'doc-classify-text',
      organizationId: 'org-1',
      filename: 'upload-2026.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      status: 'PROCESSING',
      documentType: 'BANK_STATEMENT',
      vendorName: null,
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      totalAmount: null,
      currency: 'USD',
      extractedAt: new Date(),
    });

    const result = await service.processDocument('doc-classify-text', {
      id: 'user-1',
      organizationId: 'org-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect(readSpy).toHaveBeenCalledWith('storage/organizations/org-1/documents/upload-2026.pdf');
    expect(prismaMock.document.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'doc-classify-text' },
      data: expect.objectContaining({ documentType: 'BANK_STATEMENT' }),
    }));
    expect(result.documentType).toBe('BANK_STATEMENT');
    readSpy.mockRestore();
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

    const textSpy = jest.spyOn(service as any, 'readDocumentTextHint').mockResolvedValue('Vendor: Acme Supplies\nInvoice Number: 1042\nInvoice Date: 2026-09-01\nDue Date: 2026-09-30\nSubtotal: 1500\nTax: 0\nTotal: 1500\nCurrency: USD');
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
    textSpy.mockRestore();
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
