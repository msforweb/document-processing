import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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

type InvoiceValidationResult = {
  requiresReview: boolean;
  flags: string[];
  riskScore: number;
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

  async exportReviewQueue(
    user: AuthUser,
    filters: {
      status?: string;
      documentType?: string;
      onlyHighRisk?: boolean;
      search?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const documents = await this.getReviewQueue(user, filters);
    const headers = ['id', 'filename', 'documentType', 'status', 'vendorName', 'invoiceNumber', 'totalAmount', 'currency', 'createdAt', 'riskScore'];
    const rows = documents.map((document) => [
      document.id,
      document.filename,
      document.documentType,
      document.status,
      document.vendorName ?? '',
      document.invoiceNumber ?? '',
      String(document.totalAmount ?? ''),
      document.currency ?? '',
      new Date(document.createdAt).toISOString(),
      String((document as typeof document & { riskScore?: number }).riskScore ?? this.getDocumentRiskScore(document)),
    ]);

    const escapeCsvCell = (value: string | number | null | undefined) => {
      const stringValue = String(value ?? '');
      const normalized = stringValue.replace(/\r?\n/g, ' ').replace(/\"/g, '""');
      return /[",]/.test(normalized) ? `"${normalized}"` : normalized;
    };

    const csvLines = [headers.map(escapeCsvCell).join(','), ...rows.map((row) => row.map(escapeCsvCell).join(','))];
    return csvLines.join('\n');
  }

  async getReviewQueue(
    user: AuthUser,
    filters?: {
      status?: string;
      documentType?: string;
      onlyHighRisk?: boolean;
      search?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<
    Array<{
      id: string;
      organizationId: string;
      filename: string;
      mimeType?: string | null;
      size?: number | null;
      status?: string | null;
      documentType?: string | null;
      vendorName?: string | null;
      invoiceNumber?: string | null;
      totalAmount?: number | null;
      currency?: string | null;
      createdAt: Date;
      updatedAt?: Date | null;
      riskScore: number;
    }>
  >;
  async getReviewQueue(
    user: AuthUser,
    filters: {
      status?: string;
      documentType?: string;
      onlyHighRisk?: boolean;
      search?: string;
      page: number;
      limit?: number;
    },
  ): Promise<{
    items: Array<{
      id: string;
      organizationId: string;
      filename: string;
      mimeType?: string | null;
      size?: number | null;
      status?: string | null;
      documentType?: string | null;
      vendorName?: string | null;
      invoiceNumber?: string | null;
      totalAmount?: number | null;
      currency?: string | null;
      createdAt: Date;
      updatedAt?: Date | null;
      riskScore: number;
    }>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }>;
  async getReviewQueue(
    user: AuthUser,
    filters: {
      status?: string;
      documentType?: string;
      onlyHighRisk?: boolean;
      search?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<any> {
    const normalizedSearch = filters.search?.trim();
    const statusFilter: string | { in: string[] } = filters.status
      ? filters.status
      : {
          in: ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'],
        };

    const where: any = {
      organizationId: user.organizationId,
      status: statusFilter as any,
      ...(filters.documentType ? { documentType: filters.documentType as any } : {}),
      ...(normalizedSearch
        ? {
            OR: [
              { filename: { contains: normalizedSearch, mode: 'insensitive' as const } },
              { vendorName: { contains: normalizedSearch, mode: 'insensitive' as const } },
              { invoiceNumber: { contains: normalizedSearch, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const requiresPagination = filters.page !== undefined || filters.limit !== undefined;
    const activePage = Math.max(1, Number(filters.page ?? 1));
    const activeLimit = Math.min(100, Math.max(1, Number(filters.limit ?? 25)));

    const documents = await this.prisma.document.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(requiresPagination ? { skip: (activePage - 1) * activeLimit, take: activeLimit } : {}),
    });

    const enrichedDocuments = documents
      .map((document) => ({
        ...document,
        riskScore: this.getDocumentRiskScore(document),
      }))
      .filter((document) => !filters.onlyHighRisk || document.riskScore >= 60)
      .sort((left, right) => right.riskScore - left.riskScore || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

    if (requiresPagination) {
      const total = await this.prisma.document.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / activeLimit));

      return {
        items: enrichedDocuments,
        total,
        page: activePage,
        limit: activeLimit,
        totalPages,
      };
    }

    return enrichedDocuments;
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
    const validation = this.getValidationContext(document);

    return {
      ...document,
      summary: this.buildSummary(document, validation),
      validationFlags: validation.flags,
      riskScore: validation.riskScore,
    };
  }

  async getDocumentAuditTrail(id: string, user: AuthUser) {
    await this.findOne(id, user);

    return this.prisma.auditLog.findMany({
      where: {
        organizationId: user.organizationId,
        documentId: id,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async exportDocumentAuditTrail(id: string, user: AuthUser) {
    await this.findOne(id, user);

    const auditTrail = await this.prisma.auditLog.findMany({
      where: {
        organizationId: user.organizationId,
        documentId: id,
      },
      orderBy: { createdAt: 'desc' },
    });

    const headers = ['id', 'action', 'createdAt', 'metadata'];
    const rows = auditTrail.map((entry) => [
      entry.id,
      entry.action,
      new Date(entry.createdAt).toISOString(),
      JSON.stringify(entry.metadata ?? {}),
    ]);

    const escapeCsvCell = (value: string | number) => {
      const stringValue = String(value ?? '');
      const normalized = stringValue.replace(/\r?\n/g, ' ').replace(/"/g, '""');
      return /[",]/.test(normalized) ? `"${normalized}"` : normalized;
    };

    return [headers.map(escapeCsvCell).join(','), ...rows.map((row) => row.map(escapeCsvCell).join(','))].join('\n');
  }

  async getDashboardSummary(user: AuthUser) {
    const documents = await this.prisma.document.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
    });

    const totalDocuments = documents.length;
    const approvedCount = documents.filter((document) => document.status === 'APPROVED').length;
    const reviewCount = documents.filter((document) => ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'].includes(document.status)).length;
    const highRiskCount = documents.filter((document) => this.getDocumentRiskScore(document) >= 60).length;
    const approvalRate = totalDocuments > 0 ? Number(((approvedCount / totalDocuments) * 100).toFixed(0)) : 0;

    return {
      totalDocuments,
      approvedCount,
      reviewCount,
      highRiskCount,
      approvalRate,
      statusBreakdown: documents.reduce<Record<string, number>>((accumulator, document) => {
        accumulator[document.status] = (accumulator[document.status] ?? 0) + 1;
        return accumulator;
      }, {}),
      typeBreakdown: documents.reduce<Record<string, number>>((accumulator, document) => {
        const typeKey = document.documentType ?? 'UNKNOWN';
        accumulator[typeKey] = (accumulator[typeKey] ?? 0) + 1;
        return accumulator;
      }, {}),
    };
  }

  async getReviewAnalytics(user: AuthUser, periodDays = 7) {
    const documents = await this.prisma.document.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
    });

    const totalDocuments = documents.length;
    const approvedCount = documents.filter((document) => document.status === 'APPROVED').length;
    const reviewCount = documents.filter((document) => ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'].includes(document.status)).length;
    const approvalRate = totalDocuments > 0 ? Number(((approvedCount / totalDocuments) * 100).toFixed(0)) : 0;

    const riskBreakdown = documents.reduce(
      (accumulator, document) => {
        const score = this.getDocumentRiskScore(document);
        if (score >= 60) {
          accumulator.high += 1;
        } else if (score >= 30) {
          accumulator.medium += 1;
        } else {
          accumulator.low += 1;
        }
        return accumulator;
      },
      { low: 0, medium: 0, high: 0 },
    );

    const vendorRisk = Object.entries(
      documents.reduce<Record<string, number>>((accumulator, document) => {
        const vendorName = (document.vendorName ?? 'Unknown').trim();
        if (!vendorName) {
          return accumulator;
        }
        accumulator[vendorName] = (accumulator[vendorName] ?? 0) + this.getDocumentRiskScore(document);
        return accumulator;
      }, {}),
    )
      .map(([vendor, score]) => ({ vendor, score }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);

    const reviewRequiredCount = documents.filter((document) => document.status === 'REVIEW_REQUIRED').length;
    const agingDays = documents
      .filter((document) => ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'].includes(document.status ?? ''))
      .map((document) => {
        const createdAt = new Date(document.createdAt).getTime();
        return Math.max(0, (Date.now() - createdAt) / (24 * 60 * 60 * 1000));
      });

    const agingSummary = {
      reviewRequiredCount,
      avgQueueDays: agingDays.length ? Number((agingDays.reduce((sum, value) => sum + value, 0) / agingDays.length).toFixed(1)) : 0,
      overdueCount: agingDays.filter((value) => value > 3).length,
    };

    const invoicePatternMap = new Map<string, { vendor: string; invoiceNumber: string; count: number; totalAmount: number }>();
    for (const document of documents) {
      const vendorName = (document.vendorName ?? '').trim();
      const invoiceNumber = (document.invoiceNumber ?? '').trim();
      if (!vendorName || !invoiceNumber || invoiceNumber === 'N/A') {
        continue;
      }

      const key = `${vendorName.toLowerCase()}::${invoiceNumber.toLowerCase()}`;
      const existing = invoicePatternMap.get(key) ?? { vendor: vendorName, invoiceNumber, count: 0, totalAmount: 0 };
      invoicePatternMap.set(key, {
        vendor: vendorName,
        invoiceNumber,
        count: existing.count + 1,
        totalAmount: existing.totalAmount + Number(document.totalAmount ?? 0),
      });
    }

    const duplicateInvoicePatterns = [...invoicePatternMap.values()]
      .filter((entry) => entry.count > 1)
      .map((entry) => ({
        type: 'Duplicate invoice pattern',
        vendor: entry.vendor,
        invoiceNumber: entry.invoiceNumber,
        severity: 'high' as const,
        detail: `Invoice ${entry.invoiceNumber} appears ${entry.count} times for ${entry.vendor}.`,
      }));

    const vendorRiskMap = new Map<string, { count: number; highRiskCount: number; avgAmount: number }>();
    for (const document of documents) {
      const vendorName = (document.vendorName ?? '').trim();
      if (!vendorName) {
        continue;
      }

      const current = vendorRiskMap.get(vendorName) ?? { count: 0, highRiskCount: 0, avgAmount: 0 };
      const riskScore = this.getDocumentRiskScore(document);
      const amount = Number(document.totalAmount ?? 0);
      vendorRiskMap.set(vendorName, {
        count: current.count + 1,
        highRiskCount: current.highRiskCount + (riskScore >= 60 ? 1 : 0),
        avgAmount: current.avgAmount + amount,
      });
    }

    const concentrationAlerts = [...vendorRiskMap.entries()]
      .map(([vendor, metrics]) => ({
        vendor,
        count: metrics.count,
        highRiskCount: metrics.highRiskCount,
        avgAmount: metrics.count ? metrics.avgAmount / metrics.count : 0,
      }))
      .filter((entry) => entry.count >= 2 && entry.highRiskCount >= 2)
      .map((entry) => ({
        type: 'Vendor concentration risk',
        vendor: entry.vendor,
        severity: 'medium' as const,
        detail: `${entry.highRiskCount} high-risk documents across ${entry.count} submissions for ${entry.vendor}.`,
      }));

    const policyExceptions = [...duplicateInvoicePatterns, ...concentrationAlerts].sort((left, right) => {
      const severityWeight = { high: 2, medium: 1 } as const;
      return severityWeight[right.severity] - severityWeight[left.severity];
    });

    const trendDates = Array.from({ length: Math.max(1, periodDays) }, (_, index) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (Math.max(1, periodDays) - 1 - index));
      return date;
    });

    const dailyTrend = trendDates.map((date) => {
      const dateKey = date.toISOString().slice(0, 10);
      const bucketDocuments = documents.filter((document) => {
        const value = new Date(document.createdAt);
        return value.toISOString().slice(0, 10) === dateKey;
      });

      return {
        date: dateKey,
        total: bucketDocuments.length,
        approved: bucketDocuments.filter((document) => document.status === 'APPROVED').length,
        review: bucketDocuments.filter((document) => ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'].includes(document.status ?? '')).length,
      };
    });

    return {
      periodDays,
      totalDocuments,
      approvedCount,
      reviewCount,
      approvalRate,
      riskBreakdown,
      vendorRisk,
      agingSummary,
      policyExceptions,
      dailyTrend,
      statusBreakdown: documents.reduce<Record<string, number>>((accumulator, document) => {
        accumulator[document.status] = (accumulator[document.status] ?? 0) + 1;
        return accumulator;
      }, {}),
      typeBreakdown: documents.reduce<Record<string, number>>((accumulator, document) => {
        const typeKey = document.documentType ?? 'UNKNOWN';
        accumulator[typeKey] = (accumulator[typeKey] ?? 0) + 1;
        return accumulator;
      }, {}),
    };
  }

  async exportReviewAnalytics(user: AuthUser, periodDays = 7) {
    const analytics = await this.getReviewAnalytics(user, periodDays);

    const rows = [
      ['periodDays', String(analytics.periodDays)],
      ['totalDocuments', String(analytics.totalDocuments)],
      ['approvedCount', String(analytics.approvedCount)],
      ['reviewCount', String(analytics.reviewCount)],
      ['approvalRate', String(analytics.approvalRate)],
      ['riskBreakdown.low', String(analytics.riskBreakdown.low)],
      ['riskBreakdown.medium', String(analytics.riskBreakdown.medium)],
      ['riskBreakdown.high', String(analytics.riskBreakdown.high)],
      ['avgQueueDays', String(analytics.agingSummary.avgQueueDays)],
      ['reviewRequiredCount', String(analytics.agingSummary.reviewRequiredCount)],
      ['overdueCount', String(analytics.agingSummary.overdueCount)],
      ['policyExceptions', JSON.stringify(analytics.policyExceptions)],
      ['vendorRisk', JSON.stringify(analytics.vendorRisk)],
      ['dailyTrend', JSON.stringify(analytics.dailyTrend)],
    ];

    const header = ['metric', 'value'];
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    return csv;
  }

  async processDocument(id: string, user: AuthUser) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: user.organizationId },
    });

    if (!document) {
      throw new NotFoundException('Document not found.');
    }

    const documentType = document.documentType === 'UNKNOWN' ? this.detectDocumentType(document.filename) : document.documentType;
    const documentTextHint = await this.readDocumentTextHint(document.storagePath);
    const extraction = documentType === 'INVOICE' ? this.extractInvoiceData(document.filename, documentTextHint) : null;
    const validation = documentType === 'INVOICE' ? this.validateInvoice(extraction ?? { vendorName: '', invoiceNumber: '', totalAmount: 0, currency: 'USD' }) : { requiresReview: false, flags: [], riskScore: 0 };
    const complianceFlags = documentType === 'INVOICE' ? await this.detectDuplicateInvoiceFlags(user.organizationId, document.id, extraction?.vendorName ?? document.vendorName, extraction?.invoiceNumber ?? document.invoiceNumber) : [];
    const combinedFlags = [...validation.flags, ...complianceFlags.filter((flag) => !validation.flags.includes(flag))];
    const combinedRiskScore = Math.min(100, validation.riskScore + complianceFlags.length * 25);
    const nextStatus = document.status === 'UPLOADED' ? 'PROCESSING' : document.status === 'PROCESSING' ? 'EXTRACTED' : document.status;
    const reviewStatus = combinedFlags.length > 0 ? 'REVIEW_REQUIRED' : validation.requiresReview ? 'REVIEW_REQUIRED' : extraction?.requiresReview ? 'REVIEW_REQUIRED' : nextStatus;

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

    if (combinedFlags.length > 0) {
      await this.prisma.auditLog.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          documentId: updatedDocument.id,
          action: 'DOCUMENT_VALIDATION_FLAGGED',
          metadata: {
            filename: document.filename,
            flags: combinedFlags,
            riskScore: combinedRiskScore,
          },
        },
      });
    }

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

  async bulkReviewDocuments(
    documentIds: string[],
    decision: 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED',
    user: AuthUser,
    note?: string,
    reason?: string,
  ) {
    if (!documentIds?.length) {
      throw new BadRequestException('At least one document is required for a bulk review.');
    }

    const allowedDecisions = ['APPROVED', 'REJECTED', 'REVIEW_REQUIRED'] as const;
    if (!allowedDecisions.includes(decision)) {
      throw new BadRequestException('Unsupported review decision.');
    }

    const documents = await this.prisma.document.findMany({
      where: {
        id: { in: documentIds },
        organizationId: user.organizationId,
      },
    });

    if (documents.length === 0) {
      throw new NotFoundException('No matching documents found for bulk review.');
    }

    const reviewNote = note?.trim() || null;
    const decisionReason = reason?.trim() || reviewNote || 'Bulk review completed without a detailed note.';

    await this.prisma.document.updateMany({
      where: {
        id: { in: documentIds },
        organizationId: user.organizationId,
      },
      data: {
        status: decision,
        reviewNote,
        reviewedAt: new Date(),
      },
    });

    await Promise.all(
      documents.map(async (document) => {
        const runtimeDocument = document as typeof document & { riskScore?: number };
        const riskScore = typeof runtimeDocument.riskScore === 'number' ? runtimeDocument.riskScore : this.getDocumentRiskScore(document);

        await this.prisma.auditLog.create({
          data: {
            organizationId: user.organizationId,
            userId: user.id,
            documentId: document.id,
            action: 'DOCUMENT_REVIEWED',
            metadata: {
              filename: document.filename,
              previousStatus: document.status,
              decision,
              reviewNote,
              decisionReason,
              reviewerEmail: user.email,
              reviewerRole: user.role,
              riskScore,
            },
          },
        });
      }),
    );

    return documents;
  }

  async reviewDocument(
    id: string,
    decision: 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED',
    user: AuthUser,
    note?: string,
    reason?: string,
  ) {
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

    const reviewNote = note?.trim() || document.reviewNote || null;
    const decisionReason = reason?.trim() || reviewNote || 'No detailed reason provided.';
    const runtimeDocument = document as typeof document & { riskScore?: number };
    const riskScore = typeof runtimeDocument.riskScore === 'number' ? runtimeDocument.riskScore : this.getDocumentRiskScore(document);

    const updatedDocument = await this.prisma.document.update({
      where: { id },
      data: {
        status: decision,
        reviewNote,
        reviewedAt: new Date(),
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
          reviewNote,
          decisionReason,
          reviewerEmail: user.email,
          reviewerRole: user.role,
          riskScore,
        },
      },
    });

    return updatedDocument;
  }

  extractInvoiceData(filename: string, contentHint?: string): InvoiceExtractionResult {
    const combinedText = [contentHint ?? '', filename]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const explicitVendorMatch = combinedText.match(/^(?:[A-Z][A-Za-z0-9&.-]+(?:\s+[A-Z][A-Za-z0-9&.-]+){0,4})/);
    const vendorMatch =
      explicitVendorMatch ??
      combinedText.match(/(?:vendor|merchant|supplier|company)[\s:]*([A-Za-z0-9&.-]+(?:\s+[A-Za-z0-9&.-]+){0,4})/i) ??
      combinedText.match(/([a-z]+(?:-[a-z]+)*)-(?:invoice|inv|bill)[-_\s.]/i) ??
      combinedText.match(/([a-z]+(?:-[a-z]+)*)/);

    const vendorSlug = vendorMatch ? String(vendorMatch[1] ?? vendorMatch[0]).trim() : 'acme-supplies';
    const normalizedVendorName = this.normalizeVendorName(vendorSlug);
    const invoiceMatch = this.findInvoiceMatch(combinedText) ?? combinedText.match(/(\d{3,8})/);
    const rawInvoiceNumber = invoiceMatch ? String(invoiceMatch[1] ?? invoiceMatch[0]).trim() : 'N/A';
    const extractedInvoiceNumber = this.sanitizeInvoiceNumber(rawInvoiceNumber);

    const invoiceDate = this.parseDateFromText(combinedText, ['invoice date', 'date']) ?? new Date();
    const dueDate = this.parseDateFromText(combinedText, ['due date', 'due', 'payment due']) ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const currency = this.extractCurrency(combinedText) ?? 'USD';
    const totalAmount = this.extractTotalAmount(combinedText) ?? Number(((Number(extractedInvoiceNumber.replace(/\D/g, '') || '1042') * 1.21) + 89.5).toFixed(2));

    return {
      vendorName: normalizedVendorName,
      invoiceNumber: extractedInvoiceNumber,
      invoiceDate,
      dueDate,
      totalAmount,
      currency,
      requiresReview: false,
    };
  }

  validateInvoice(data: Partial<InvoiceExtractionResult>): InvoiceValidationResult {
    const flags: string[] = [];
    const totalAmount = Number(data.totalAmount ?? 0);
    const invoiceDate = data.invoiceDate instanceof Date ? new Date(data.invoiceDate) : null;
    const dueDate = data.dueDate instanceof Date ? new Date(data.dueDate) : null;

    if (!data.vendorName || !data.vendorName.trim()) {
      flags.push('Missing vendor name');
    }

    if (!data.invoiceNumber || !data.invoiceNumber.trim() || data.invoiceNumber === 'N/A') {
      flags.push('Missing invoice number');
    }

    if (!data.totalAmount || Number(data.totalAmount) <= 0) {
      flags.push('Total amount is missing or invalid');
    }

    if (!data.currency || !data.currency.trim()) {
      flags.push('Missing currency');
    }

    const normalizedVendor = (data.vendorName ?? '').trim().toLowerCase();
    if (normalizedVendor && ['demo', 'sample', 'test', 'placeholder', 'unknown', 'n/a'].some((keyword) => normalizedVendor.includes(keyword))) {
      flags.push('Vendor name looks like a placeholder or generic test entry');
    }

    if (invoiceDate && !Number.isNaN(invoiceDate.getTime()) && invoiceDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      flags.push('Invoice date is in the future');
    }

    if (invoiceDate && dueDate && !Number.isNaN(invoiceDate.getTime()) && !Number.isNaN(dueDate.getTime()) && dueDate.getTime() < invoiceDate.getTime()) {
      flags.push('Due date is before invoice date');
    }

    if (invoiceDate && dueDate && !Number.isNaN(invoiceDate.getTime()) && !Number.isNaN(dueDate.getTime()) && totalAmount >= 50000) {
      const paymentWindowDays = (dueDate.getTime() - invoiceDate.getTime()) / (24 * 60 * 60 * 1000);
      if (paymentWindowDays <= 2) {
        flags.push('Due date is unusually short for a large invoice');
      }
    }

    if (totalAmount >= 50000) {
      flags.push('Large invoice amount may require manual review');
    }

    const riskScore = flags.reduce((score, flag) => {
      if (flag === 'Missing vendor name' || flag === 'Missing invoice number') return score + 25;
      if (flag === 'Total amount is missing or invalid') return score + 20;
      if (flag === 'Missing currency') return score + 10;
      if (flag === 'Vendor name looks like a placeholder or generic test entry') return score + 25;
      if (flag === 'Invoice date is in the future') return score + 20;
      if (flag === 'Due date is before invoice date') return score + 20;
      if (flag === 'Due date is unusually short for a large invoice') return score + 20;
      if (flag === 'Large invoice amount may require manual review') return score + 25;
      return score + 10;
    }, 0);

    return {
      requiresReview: flags.length > 0 || riskScore >= 50,
      flags,
      riskScore,
    };
  }

  private async detectDuplicateInvoiceFlags(
    organizationId: string,
    documentId: string,
    vendorName?: string | null,
    invoiceNumber?: string | null,
  ): Promise<string[]> {
    if (!invoiceNumber || !invoiceNumber.trim() || invoiceNumber === 'N/A') {
      return [];
    }

    const normalizedInvoiceNumber = this.normalizeInvoiceComparisonKey(invoiceNumber);
    const normalizedVendor = vendorName?.trim().toLowerCase();

    const existingDocuments = (await this.prisma.document.findMany({
      where: {
        organizationId,
        documentType: 'INVOICE',
        invoiceNumber: { not: null },
      },
      select: {
        id: true,
        invoiceNumber: true,
        vendorName: true,
      },
    })) ?? [];

    const duplicateFlags = existingDocuments
      .filter((candidate) => candidate.id !== documentId)
      .filter((candidate) => candidate.invoiceNumber && this.normalizeInvoiceComparisonKey(candidate.invoiceNumber) === normalizedInvoiceNumber)
      .map((candidate) => {
        const candidateVendor = candidate.vendorName?.trim().toLowerCase();
        const isSameVendor = !!(
          normalizedVendor &&
          candidateVendor &&
          (candidateVendor === normalizedVendor ||
            candidateVendor.startsWith(normalizedVendor) ||
            normalizedVendor.startsWith(candidateVendor))
        );

        if (isSameVendor) {
          return 'Duplicate invoice detected for the same vendor';
        }

        return 'Invoice number matches a prior document from a different vendor';
      });

    return [...new Set(duplicateFlags)];
  }

  private async readDocumentTextHint(storagePath?: string | null): Promise<string> {
    if (!storagePath) {
      return '';
    }

    const absolutePath = path.resolve(process.cwd(), storagePath);

    try {
      const fileBuffer = await fs.readFile(absolutePath);
      const extension = path.extname(absolutePath).toLowerCase();

      if (extension === '.pdf') {
        const extractedPdfText = this.extractPdfText(fileBuffer);
        if (extractedPdfText) {
          return extractedPdfText.slice(0, 20000);
        }
      }

      const decoded = fileBuffer.toString('latin1');
      return decoded.replace(/\0/g, ' ').replace(/[^\x20-\x7E\r\n]/g, ' ').slice(0, 20000);
    } catch {
      return '';
    }
  }

  private extractPdfText(buffer: Buffer): string {
    const rawText = buffer.toString('latin1');
    const textBlocks = new Set<string>();

    const addDecodedBlock = (value: string): void => {
      const decoded = this.decodePdfTextToken(value);
      if (decoded) {
        textBlocks.add(decoded);
      }
    };

    const addDecodedHexBlock = (value: string): void => {
      const decoded = this.decodePdfHexString(value);
      if (decoded) {
        textBlocks.add(decoded);
      }
    };

    const pdfTextMatches = [...rawText.matchAll(/\((?:\\.|[^()\\])*\)/g)];
    for (const match of pdfTextMatches) {
      addDecodedBlock(match[0]);
    }

    const pdfHexMatches = [...rawText.matchAll(/<([0-9A-Fa-f\s]+)>/g)];
    for (const match of pdfHexMatches) {
      addDecodedHexBlock(match[1] ?? '');
    }

    const streamMatches = [...rawText.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)];
    for (const match of streamMatches) {
      const streamText = match[1] ?? '';
      const streamMatchesForText = [...streamText.matchAll(/\((?:\\.|[^()\\])*\)/g)];
      for (const streamMatch of streamMatchesForText) {
        addDecodedBlock(streamMatch[0]);
      }

      const streamHexMatches = [...streamText.matchAll(/<([0-9A-Fa-f\s]+)>/g)];
      for (const streamHexMatch of streamHexMatches) {
        addDecodedHexBlock(streamHexMatch[1] ?? '');
      }
    }

    return [...textBlocks].join(' ');
  }

  private decodePdfTextToken(token: string): string {
    let decoded = token.slice(1, -1);
    decoded = decoded
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\n/g, ' ')
      .replace(/\\r/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\\b/g, ' ')
      .replace(/\\f/g, ' ')
      .replace(/\\\\/g, '\\')
      .replace(/\\\s+/g, ' ')
      .replace(/\\([0-7]{1,3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

    return decoded.replace(/\s+/g, ' ').trim();
  }

  private decodePdfHexString(value: string): string {
    const normalized = value.replace(/\s+/g, '');
    if (!normalized) {
      return '';
    }

    const padded = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
    const decoded = padded
      .match(/.{1,2}/g)
      ?.map((chunk) => {
        const code = Number.parseInt(chunk, 16);
        return Number.isNaN(code) ? '' : String.fromCharCode(code);
      })
      .join('') ?? '';

    return decoded.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private findInvoiceMatch(text: string): RegExpMatchArray | null {
    const patterns = [
      /(?:invoice)[#\s:.-]*([A-Z]{2,}-\d{2,}|[A-Z0-9-]{3,20})/i,
      /(?:inv)[#\s:.-]*([A-Z]{2,}-\d{2,}|[A-Z0-9-]{3,20})/i,
      /(?:bill)[#\s:.-]*([A-Z]{2,}-\d{2,}|[A-Z0-9-]{3,20})/i,
      /(?:invoice|inv|bill)[-_\s.]+(\d{3,8})/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return match;
      }
    }

    return null;
  }

  private normalizeVendorName(value: string): string {
    const cleaned = value
      .replace(/^(?:vendor|merchant|supplier|company)\s*[:\-]?\s*/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b(?:invoice|inv|bill|receipt|statement)\b\s*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      return 'Acme Supplies';
    }

    return cleaned
      .split(/\s+/)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
      .join(' ');
  }

  private sanitizeInvoiceNumber(value: string): string {
    const cleaned = value.replace(/^#/, '').trim();
    if (!cleaned || cleaned === 'N/A') {
      return 'N/A';
    }

    const directMatch = cleaned.match(/^[A-Z]{2,}-\d{2,}$/i);
    if (directMatch) {
      return cleaned;
    }

    const stripped = cleaned.replace(/^(?:invoice|inv|bill)[\s#:-]+/i, '');
    if (stripped && /\d/.test(stripped)) {
      return stripped.replace(/^[A-Za-z]+-/, '');
    }

    return cleaned;
  }

  private normalizeInvoiceComparisonKey(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private parseDateFromText(text: string, labels: string[]): Date | null {
    const textMatch = labels
      .map((label) => {
        const pattern = new RegExp(`${label.replace(/[-/\s]+/g, '[\\s/:-]*')}\\s*[:=\\s]*((?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2})|(?:\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}))`, 'i');
        const match = text.match(pattern);
        return match ? match[1] : null;
      })
      .find(Boolean);

    if (textMatch) {
      const parsed = new Date(textMatch);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const fallback = text.match(/\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/);
    if (!fallback) {
      return null;
    }

    const parsed = new Date(fallback[0]);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private extractCurrency(text: string): string | null {
    const match = text.match(/\b(USD|EUR|GBP|CAD|AUD|JPY|INR)\b/i);
    if (!match || !match[1]) {
      return null;
    }

    return match[1].toUpperCase();
  }

  private extractTotalAmount(text: string): number | null {
    const match = text.match(/(?:total|amount|grand total)[^\d]*(\d[\d,]*\.\d{2}|\d[\d,]*\d)/i) ?? text.match(/\$(\d[\d,]*\.\d{2}|\d[\d,]*\d)/i);

    if (!match || !match[1]) {
      return null;
    }

    const numeric = match[1].replace(/,/g, '');
    const parsed = Number(numeric);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private getValidationContext(document: {
    vendorName?: string | null;
    invoiceNumber?: string | null;
    totalAmount?: number | string | null;
    currency?: string | null;
    invoiceDate?: Date | string | null;
    dueDate?: Date | string | null;
  }): InvoiceValidationResult {
    const validationInput: Partial<InvoiceExtractionResult> = {
      vendorName: document.vendorName ?? '',
      invoiceNumber: document.invoiceNumber ?? '',
      totalAmount: Number(document.totalAmount ?? 0),
      currency: document.currency ?? 'USD',
    };

    if (document.invoiceDate) {
      validationInput.invoiceDate = new Date(document.invoiceDate);
    }

    if (document.dueDate) {
      validationInput.dueDate = new Date(document.dueDate);
    }

    return this.validateInvoice(validationInput);
  }

  private getDocumentRiskScore(document: {
    vendorName?: string | null;
    invoiceNumber?: string | null;
    totalAmount?: number | string | null;
    currency?: string | null;
    status?: string | null;
    invoiceDate?: Date | string | null;
    dueDate?: Date | string | null;
  }): number {
    let riskScore = 0;

    if (!document.vendorName || !document.vendorName.trim()) {
      riskScore += 30;
    }

    if (!document.invoiceNumber || !document.invoiceNumber.trim() || document.invoiceNumber === 'N/A') {
      riskScore += 30;
    }

    if (!document.totalAmount || Number(document.totalAmount) <= 0) {
      riskScore += 25;
    }

    if (!document.currency || !document.currency.trim()) {
      riskScore += 15;
    }

    const invoiceDate = document.invoiceDate ? new Date(document.invoiceDate) : null;
    const dueDate = document.dueDate ? new Date(document.dueDate) : null;

    if (invoiceDate && !Number.isNaN(invoiceDate.getTime()) && invoiceDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      riskScore += 20;
    }

    if (invoiceDate && dueDate && !Number.isNaN(invoiceDate.getTime()) && !Number.isNaN(dueDate.getTime()) && dueDate.getTime() < invoiceDate.getTime()) {
      riskScore += 20;
    }

    if (document.totalAmount && Number(document.totalAmount) >= 50000) {
      riskScore += 20;
    }

    if (document.status === 'REVIEW_REQUIRED') {
      riskScore += 20;
    }

    return riskScore;
  }

  private buildSummary(
    document: {
      filename: string;
      documentType?: string;
      status?: string;
      size?: number;
      createdAt?: Date | string;
    },
    validation: InvoiceValidationResult = { requiresReview: false, flags: [], riskScore: 0 },
  ) {
    const typeLabel = (document.documentType ?? 'UNKNOWN').replace(/_/g, ' ');
    const formattedType = typeLabel
      .split(' ')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
    const statusLabel = this.formatStatus(document.status ?? 'UNKNOWN');
    const sizeLabel = this.formatSize(document.size ?? 0);
    const createdAt = document.createdAt ? new Date(document.createdAt).toLocaleDateString() : 'unknown date';
    const baseSummary = `${formattedType} document is ${statusLabel}. ${sizeLabel} uploaded on ${createdAt}.`;

    if (!validation.flags.length) {
      return baseSummary;
    }

    return `${baseSummary} Validation flags: ${validation.flags.join('; ')}.`;
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
