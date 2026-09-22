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
    expect(prismaMock.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-2' },
      data: {
        status: 'PROCESSING',
        documentType: 'INVOICE',
      },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    expect(result.status).toBe('PROCESSING');
  });
});
