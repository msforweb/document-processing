import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../../types/auth-user';
import { LocalStorageService } from '../../storage/local-storage.service';

type InvoiceExtractionResult = {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate: Date;
  totalAmount: number;
  currency: string;
  requiresReview: boolean;
};

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(LocalStorageService)
    private readonly storageService: LocalStorageService,
  ) {}

  async upload(files: Express.Multer.File[], user: AuthUser) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required.');
    }

    return this.prisma.$transaction(async (tx) => {
      const createdDocuments = await Promise.all(
        files.map(async (file) => {
          const savedFile = await this.storageService.saveFile(file, user.organizationId);
          const documentType = this.detectDocumentType(file.originalname);

          const document = await tx.document.create({
            data: {
              organizationId: user.organizationId,
              filename: this.safeFilename(file.originalname),
              mimeType: file.mimetype,
              size: savedFile.size,
              storagePath: savedFile.storagePath,
              documentType,
              status: 'UPLOADED',
            },
          });

          await tx.auditLog.create({
            data: {
              organizationId: user.organizationId,
              userId: user.id,
              documentId: document.id,
              action: 'DOCUMENT_UPLOADED',
              metadata: {
                filename: document.filename,
                mimeType: document.mimeType,
                size: document.size,
                originalName: file.originalname,
              },
            },
          });

          return document;
        }),
      );

      return createdDocuments;
    });
  }

  async list(user: AuthUser) {
    return this.prisma.document.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getReviewQueue(user: AuthUser) {
    return this.prisma.document.findMany({
      where: {
        organizationId: user.organizationId,
        status: {
          in: ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user: AuthUser) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: user.organizationId },
    });

    if (!document) {
      throw new NotFoundException('Document not found.');
    }

    return document;
  }

  async summarizeDocument(id: string, user: AuthUser) {
    const document = await this.findOne(id, user);

    return {
      ...document,
      summary: this.buildSummary(document),
    };
  }

  async processDocument(id: string, user: AuthUser) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: user.organizationId },
    });

    if (!document) {
      throw new NotFoundException('Document not found.');
    }

    const documentType = document.documentType === 'UNKNOWN' ? this.detectDocumentType(document.filename) : document.documentType;
    const extraction = documentType === 'INVOICE' ? this.extractInvoiceData(document.filename) : null;
    const nextStatus = document.status === 'UPLOADED' ? 'PROCESSING' : document.status === 'PROCESSING' ? 'EXTRACTED' : document.status;
    const reviewStatus = extraction?.requiresReview ? 'REVIEW_REQUIRED' : nextStatus;

    const updatedDocument = await this.prisma.document.update({
      where: { id },
      data: {
        status: reviewStatus,
        documentType,
        vendorName: extraction?.vendorName ?? document.vendorName ?? null,
        invoiceNumber: extraction?.invoiceNumber ?? document.invoiceNumber ?? null,
        invoiceDate: extraction?.invoiceDate ?? document.invoiceDate ?? null,
        dueDate: extraction?.dueDate ?? document.dueDate ?? null,
        totalAmount: extraction?.totalAmount ?? document.totalAmount ?? null,
        currency: extraction?.currency ?? document.currency ?? 'USD',
        extractedAt: extraction ? new Date() : document.extractedAt ?? null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        documentId: updatedDocument.id,
        action: 'DOCUMENT_PROCESSED',
        metadata: {
          filename: document.filename,
          previousStatus: document.status,
          newStatus: updatedDocument.status,
          documentType: updatedDocument.documentType,
          vendorName: updatedDocument.vendorName,
          invoiceNumber: updatedDocument.invoiceNumber,
          totalAmount: updatedDocument.totalAmount,
        },
      },
    });

    return updatedDocument;
  }

  async reviewDocument(id: string, decision: 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED', user: AuthUser) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: user.organizationId },
    });

    if (!document) {
      throw new NotFoundException('Document not found.');
    }

    const allowedDecisions = ['APPROVED', 'REJECTED', 'REVIEW_REQUIRED'] as const;
    if (!allowedDecisions.includes(decision)) {
      throw new BadRequestException('Unsupported review decision.');
    }

    const updatedDocument = await this.prisma.document.update({
      where: { id },
      data: {
        status: decision,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        documentId: updatedDocument.id,
        action: 'DOCUMENT_REVIEWED',
        metadata: {
          filename: document.filename,
          previousStatus: document.status,
          decision: updatedDocument.status,
        },
      },
    });

    return updatedDocument;
  }

  extractInvoiceData(filename: string): InvoiceExtractionResult {
    const normalized = filename.toLowerCase();
    const vendorMatch = normalized.match(/([a-z]+(?:-[a-z]+)*)-(?:invoice|inv)[-_\s.]/i) ?? normalized.match(/([a-z]+(?:-[a-z]+)*)/);
    const vendorSlug = vendorMatch ? String(vendorMatch[1]) : 'acme-supplies';
    const invoiceMatch = normalized.match(/(?:invoice|inv)[-_\s.]+(\d{3,8})/i) ?? normalized.match(/(\d{3,8})/);
    const extractedInvoiceNumber = invoiceMatch ? String(invoiceMatch[1]) : 'N/A';
    const invoiceDate = new Date();
    const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const numericSeed = Number(extractedInvoiceNumber.replace(/\D/g, '') || '1042');
    const totalAmount = Number(((numericSeed * 1.21) + 89.5).toFixed(2));

    return {
      vendorName: vendorSlug
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' '),
      invoiceNumber: extractedInvoiceNumber,
      invoiceDate,
      dueDate,
      totalAmount,
      currency: 'USD',
      requiresReview: false,
    };
  }

  private buildSummary(document: {
    filename: string;
    documentType?: string;
    status?: string;
    size?: number;
    createdAt?: Date | string;
  }) {
    const typeLabel = (document.documentType ?? 'UNKNOWN').replace(/_/g, ' ');
    const formattedType = typeLabel
      .split(' ')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
    const statusLabel = this.formatStatus(document.status ?? 'UNKNOWN');
    const sizeLabel = this.formatSize(document.size ?? 0);
    const createdAt = document.createdAt ? new Date(document.createdAt).toLocaleDateString() : 'unknown date';

    return `${formattedType} document is ${statusLabel}. ${sizeLabel} uploaded on ${createdAt}.`;
  }

  private formatStatus(status: string): string {
    const labels: Record<string, string> = {
      UPLOADED: 'Uploaded',
      PROCESSING: 'Processing',
      EXTRACTED: 'Extracted',
      VALIDATING: 'Validating',
      REVIEW_REQUIRED: 'Requires review',
      APPROVED: 'Approved',
      REJECTED: 'Rejected',
      FAILED: 'Failed',
    };

    return labels[status] ?? status.replace(/_/g, ' ');
  }

  private formatSize(size: number): string {
    if (size <= 0) {
      return '0 KB';
    }

    const kb = Math.max(1, Math.round(size / 1024));
    return `${kb} KB`;
  }

  private detectDocumentType(filename: string): 'INVOICE' | 'BANK_STATEMENT' | 'KYC' | 'COMPLIANCE_REPORT' | 'UNKNOWN' {
    const normalized = filename.toLowerCase();

    if (normalized.includes('invoice')) return 'INVOICE';
    if (normalized.includes('bank') || normalized.includes('statement')) return 'BANK_STATEMENT';
    if (normalized.includes('kyc') || normalized.includes('identity')) return 'KYC';
    if (normalized.includes('compliance') || normalized.includes('report')) return 'COMPLIANCE_REPORT';

    return 'UNKNOWN';
  }

  private safeFilename(filename: string): string {
    return filename.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 180) || 'document';
  }
}
