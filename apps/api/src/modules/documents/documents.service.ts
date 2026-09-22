import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../../types/auth-user';
import { LocalStorageService } from '../../storage/local-storage.service';

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

  async findOne(id: string, user: AuthUser) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: user.organizationId },
    });

    if (!document) {
      throw new NotFoundException('Document not found.');
    }

    return document;
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
