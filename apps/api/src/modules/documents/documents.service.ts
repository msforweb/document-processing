import { BadRequestException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../../types/auth-user';
import { LocalStorageService } from '../../storage/local-storage.service';
import { ProcessingQueueService } from './processing-queue.service';
import { DocumentAiProvider } from './processing/document-ai-provider';
import { DocumentExtractionPipeline } from './processing/document-extraction.pipeline';
import { LocalDocumentAiProvider } from './processing/local-document-ai.provider';
import { NotificationDeliveryService } from './notification-delivery.service';

type InvoiceExtractionResult = {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: Date | null;
  dueDate: Date | null;
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
  private readonly extractionPipeline: DocumentExtractionPipeline;

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(LocalStorageService)
    private readonly storageService: LocalStorageService,
    @Optional() @Inject(ProcessingQueueService)
    private readonly processingQueue?: ProcessingQueueService,
    @Optional() @Inject(LocalDocumentAiProvider)
    documentAiProvider?: DocumentAiProvider,
    @Optional() @Inject(NotificationDeliveryService)
    private readonly notificationDelivery?: NotificationDeliveryService,
  ) {
    this.extractionPipeline = new DocumentExtractionPipeline(documentAiProvider ?? new LocalDocumentAiProvider());
  }

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
    const documents = await this.prisma.document.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
      include: { assignedReviewer: { select: { id: true, name: true, email: true } }, fraudAssessment: true },
    });

    return documents.map((document) => this.withReviewMetadata(document));
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
    const headers = ['id', 'filename', 'documentType', 'status', 'vendorName', 'invoiceNumber', 'totalAmount', 'currency', 'createdAt', 'riskScore', 'recommendedReviewLane', 'recommendedReviewer'];
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
      (document as typeof document & { recommendedReviewLane?: string }).recommendedReviewLane ?? this.getRecommendedReviewLane(document, this.getDocumentRiskScore(document)),
      (document as typeof document & { recommendedReviewer?: string }).recommendedReviewer ?? this.getRecommendedReviewer(document, this.getDocumentRiskScore(document)),
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
      include: { assignedReviewer: { select: { id: true, name: true, email: true } }, fraudAssessment: true },
      ...(requiresPagination ? { skip: (activePage - 1) * activeLimit, take: activeLimit } : {}),
    });

    const enrichedDocuments = documents
      .map((document) => this.withReviewMetadata(document))
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

  async recalculateVendorRiskProfiles(user: AuthUser) {
    const documents = await this.prisma.document.findMany({ where: { organizationId: user.organizationId }, orderBy: { createdAt: 'asc' } });
    const vendors = new Map<string, typeof documents>();
    for (const document of documents) {
      const vendorName = (document.vendorName ?? '').trim();
      if (!vendorName || /^(unknown|n\/a|not available)$/i.test(vendorName)) continue;
      const vendorKey = vendorName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const currency = (document.currency ?? 'USD').toUpperCase();
      const key = `${vendorKey}:${currency}`;
      vendors.set(key, [...(vendors.get(key) ?? []), document]);
    }

    for (const [vendorCurrencyKey, vendorDocuments] of vendors) {
      const [vendorKey, currency = 'USD'] = vendorCurrencyKey.split(':');
      if (!vendorKey) continue;
      const vendorName = (vendorDocuments.find((document) => document.vendorName?.trim())?.vendorName ?? 'Unknown').trim();
      const highRiskCount = vendorDocuments.filter((document) => this.getDocumentRiskScore(document) >= 60).length;
      const invoiceAmounts = vendorDocuments.map((document) => Number(document.totalAmount ?? 0)).filter((amount) => amount > 0);
      const averageInvoiceAmount = invoiceAmounts.length ? invoiceAmounts.reduce((sum, amount) => sum + amount, 0) / invoiceAmounts.length : null;
      const invoiceCounts = new Map<string, number>();
      for (const document of vendorDocuments) {
        const invoiceNumber = (document.invoiceNumber ?? '').trim();
        if (invoiceNumber && invoiceNumber !== 'N/A') {
          const normalized = this.normalizeInvoiceComparisonKey(invoiceNumber);
          invoiceCounts.set(normalized, (invoiceCounts.get(normalized) ?? 0) + 1);
        }
      }
      const duplicateInvoiceCount = [...invoiceCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
      const signals: string[] = [];
      if (duplicateInvoiceCount > 0) signals.push(`${duplicateInvoiceCount} repeated invoice number(s)`);
      if (highRiskCount >= 2 && highRiskCount / vendorDocuments.length >= 0.4) signals.push('Repeated high-risk submissions');

      // Flag possible invoice splitting: several near-threshold bills within one week.
      const nearThresholdInvoices = vendorDocuments
        .filter((document) => {
          const amount = Number(document.totalAmount ?? 0);
          return amount >= 10000 && amount < 50000 && document.documentType === 'INVOICE';
        })
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
      let splitPaymentDetected = false;
      for (let start = 0; start < nearThresholdInvoices.length && !splitPaymentDetected; start += 1) {
        let amountSum = 0;
        const startTime = new Date(nearThresholdInvoices[start]?.createdAt ?? 0).getTime();
        for (let end = start; end < nearThresholdInvoices.length; end += 1) {
          const current = nearThresholdInvoices[end];
          if (!current || new Date(current.createdAt).getTime() - startTime > 7 * 24 * 60 * 60 * 1000) break;
          amountSum += Number(current.totalAmount ?? 0);
          if (end > start && amountSum >= 50000) {
            splitPaymentDetected = true;
            break;
          }
        }
      }
      if (splitPaymentDetected) signals.push('Multiple near-threshold invoices total at least 50,000 within seven days');

      const maxAmount = invoiceAmounts.length ? Math.max(...invoiceAmounts) : 0;
      const typicalAmounts = invoiceAmounts.filter((amount) => amount < maxAmount);
      const typicalAverage = typicalAmounts.length ? typicalAmounts.reduce((sum, amount) => sum + amount, 0) / typicalAmounts.length : 0;
      const amountSpikeDetected = invoiceAmounts.length >= 3 && maxAmount >= Math.max(10000, typicalAverage * 2.5);
      if (amountSpikeDetected) signals.push('Invoice amount is at least 2.5x the vendor baseline');

      const averageRisk = vendorDocuments.reduce((sum, document) => sum + this.getDocumentRiskScore(document), 0) / vendorDocuments.length;
      const score = Math.min(100, Math.round(
        averageRisk * 0.45 + (highRiskCount / vendorDocuments.length) * 25 +
        (duplicateInvoiceCount > 0 ? 25 : 0) + (splitPaymentDetected ? 30 : 0) + (amountSpikeDetected ? 20 : 0),
      ));
      await this.prisma.vendorRiskProfile.upsert({
        where: { organizationId_vendorKey: { organizationId: user.organizationId, vendorKey: vendorCurrencyKey } },
        create: {
          organizationId: user.organizationId,
          vendorKey: vendorCurrencyKey,
          vendorName,
          currency,
          score,
          documentCount: vendorDocuments.length,
          highRiskCount,
          duplicateInvoiceCount,
          averageInvoiceAmount,
          signals,
          evaluatedAt: new Date(),
        },
        update: {
          vendorName,
          currency,
          score,
          documentCount: vendorDocuments.length,
          highRiskCount,
          duplicateInvoiceCount,
          averageInvoiceAmount,
          signals,
          evaluatedAt: new Date(),
        },
      });
    }
    return this.getVendorRiskProfiles(user);
  }

  async getVendorRiskProfiles(user: AuthUser) {
    return this.prisma.vendorRiskProfile.findMany({
      where: { organizationId: user.organizationId },
      orderBy: [{ score: 'desc' }, { vendorName: 'asc' }],
      take: 100,
    });
  }

  async recalculateFraudAssessments(user: AuthUser) {
    const documents = await this.prisma.document.findMany({
      where: { organizationId: user.organizationId, documentType: 'INVOICE' },
      orderBy: { createdAt: 'asc' },
    });
    const assessments = [];
    for (const document of documents) {
      const assessment = await this.assessFraudDocument(document, documents);
      if (assessment) assessments.push(assessment);
    }
    return { assessed: assessments.length, assessments };
  }

  async getFraudAssessment(id: string, user: AuthUser) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { fraudAssessment: true },
    });
    if (!document) throw new NotFoundException('Document not found.');
    return document.fraudAssessment ?? null;
  }

  private async assessFraudDocument(document: any, documentSet?: any[]) {
    if (!this.prisma.fraudAssessment || document.documentType !== 'INVOICE') return null;
    const documents = documentSet ?? await this.prisma.document.findMany({
      where: { organizationId: document.organizationId, documentType: 'INVOICE' },
      orderBy: { createdAt: 'asc' },
    });
    const vendorKey = this.normalizeVendorKey(document.vendorName);
    const currency = (document.currency ?? 'USD').toUpperCase();
    const invoiceKey = this.normalizeInvoiceComparisonKey(document.invoiceNumber ?? '');
    const amount = Number(document.totalAmount ?? 0);
    const createdAt = new Date(document.createdAt).getTime();
    const vendorDocuments = vendorKey ? documents.filter((item) => this.normalizeVendorKey(item.vendorName) === vendorKey && (item.currency ?? 'USD').toUpperCase() === currency) : [document];
    const priorVendorDocuments = vendorDocuments.filter((item) => new Date(item.createdAt).getTime() < createdAt);
    const signals: Array<{ code: string; severity: 'low' | 'medium' | 'high'; weight: number; detail: string }> = [];
    const addSignal = (code: string, severity: 'low' | 'medium' | 'high', weight: number, detail: string) => signals.push({ code, severity, weight, detail });

    if (invoiceKey && vendorDocuments.some((item) => item.id !== document.id && this.normalizeInvoiceComparisonKey(item.invoiceNumber ?? '') === invoiceKey)) {
      addSignal('DUPLICATE_INVOICE_NUMBER', 'high', 45, 'Invoice number matches another submission from this vendor.');
    }

    const historicalAmounts = priorVendorDocuments.map((item) => Number(item.totalAmount ?? 0)).filter((item) => Number.isFinite(item) && item > 0).sort((left, right) => left - right);
    if (amount > 0 && historicalAmounts.length >= 3) {
      const middle = Math.floor(historicalAmounts.length / 2);
      const median = historicalAmounts.length % 2 ? (historicalAmounts[middle] ?? 0) : ((historicalAmounts[middle - 1] ?? 0) + (historicalAmounts[middle] ?? 0)) / 2;
      if (median > 0 && amount >= 2.5 * median && amount - median >= 5000) {
        addSignal('VENDOR_AMOUNT_OUTLIER', 'high', 35, `Invoice amount is ${(amount / median).toFixed(1)}× the vendor's historical median.`);
      }
    }

    const burstCount = vendorDocuments.filter((item) => Math.abs(new Date(item.createdAt).getTime() - createdAt) <= 24 * 60 * 60 * 1000).length;
    if (burstCount >= 3) addSignal('RAPID_VENDOR_SUBMISSIONS', 'medium', 25, `${burstCount} invoices from this vendor were submitted within a 24-hour period.`);
    if (!priorVendorDocuments.length && amount >= 10000) addSignal('NEW_VENDOR_HIGH_VALUE', 'medium', 15, 'High-value invoice received before an earlier submission from this vendor is on record.');
    if (amount >= 10000 && amount % 1000 === 0) addSignal('ROUND_HIGH_VALUE_AMOUNT', 'low', 8, 'High-value invoice uses a round thousand-unit amount.');

    const invoiceDate = document.invoiceDate ? new Date(document.invoiceDate) : null;
    const dueDate = document.dueDate ? new Date(document.dueDate) : null;
    if (invoiceDate && invoiceDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) addSignal('FUTURE_INVOICE_DATE', 'medium', 20, 'Invoice date is more than one day in the future.');
    if (invoiceDate && dueDate && dueDate.getTime() < invoiceDate.getTime()) addSignal('DUE_BEFORE_INVOICE', 'high', 25, 'Due date precedes the invoice date.');

    const score = Math.min(100, signals.reduce((total, signal) => total + signal.weight, 0));
    return this.prisma.fraudAssessment.upsert({
      where: { documentId: document.id },
      create: { documentId: document.id, score, signals, assessedAt: new Date() },
      update: { score, signals, assessedAt: new Date() },
    });
  }

  private normalizeVendorKey(value?: string | null) {
    return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  async evaluateEscalations(user: AuthUser) {
    const escalations = await this.getEscalationSummary(user);
    const activeDocumentIds = escalations.map((entry) => entry.documentId);
    const [admins, activeDocuments] = await Promise.all([
      this.prisma.user.findMany({ where: { organizationId: user.organizationId, role: 'ADMIN' }, select: { id: true, email: true } }),
      activeDocumentIds.length
        ? this.prisma.document.findMany({
            where: { id: { in: activeDocumentIds }, organizationId: user.organizationId },
            select: { id: true, assignedReviewer: { select: { id: true, email: true } } },
          })
        : Promise.resolve([]),
    ]);
    const reviewersByDocument = new Map(activeDocuments.map((document) => [document.id, document.assignedReviewer]));
    let notified = 0;

    for (const escalation of escalations) {
      const reviewer = reviewersByDocument.get(escalation.documentId);
      const recipients = [...new Map([
        ...(admins ?? []).map((admin) => [admin.id, admin] as const),
        ...(reviewer ? [[reviewer.id, reviewer] as const] : []),
      ]).values()];
      const eventKey = `SLA_ESCALATION:${escalation.documentId}`;
      for (const recipient of recipients) {
        const recipientId = recipient.id;
        const existing = await this.prisma.notification.findUnique({ where: { userId_eventKey: { userId: recipientId, eventKey } } });
        const data = {
          organizationId: user.organizationId,
          userId: recipientId,
          documentId: escalation.documentId,
          eventKey,
          type: escalation.type,
          severity: escalation.severity,
          title: `${escalation.severity.toUpperCase()} review escalation`,
          message: escalation.detail,
        };
        let sendEmail = false;
        if (!existing) {
          try {
            await this.prisma.notification.create({ data });
            sendEmail = true;
          } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
          }
        } else if (existing.resolvedAt) {
          await this.prisma.notification.update({ where: { id: existing.id }, data: { ...data, readAt: null, resolvedAt: null } });
          sendEmail = true;
        }
        if (sendEmail && recipient.email) {
          await this.notificationDelivery?.sendEscalationEmail({ to: recipient.email, title: data.title, message: data.message });
        }
      }
      notified += recipients.length;
    }

    await this.prisma.notification.updateMany({
      where: {
        organizationId: user.organizationId,
        type: 'SLA_ESCALATION',
        resolvedAt: null,
        ...(activeDocumentIds.length ? { documentId: { notIn: activeDocumentIds } } : {}),
      },
      data: { resolvedAt: new Date() },
    });
    return { evaluated: escalations.length, notified, escalations };
  }

  async evaluateEscalationsForAllOrganizations() {
    const organizations = await this.prisma.document.findMany({
      where: { status: { in: ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'] } },
      distinct: ['organizationId'],
      select: { organizationId: true },
    });
    let evaluated = 0;
    let notified = 0;
    for (const { organizationId } of organizations) {
      const result = await this.evaluateEscalations({
        id: 'sla-scheduler',
        organizationId,
        email: 'sla-scheduler@local',
        role: 'ADMIN',
      });
      evaluated += result.evaluated;
      notified += result.notified;
    }
    return { organizations: organizations.length, evaluated, notified };
  }

  async getNotifications(user: AuthUser) {
    return this.prisma.notification.findMany({
      where: { organizationId: user.organizationId, userId: user.id, resolvedAt: null },
      orderBy: [{ readAt: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async markNotificationRead(id: string, user: AuthUser) {
    const result = await this.prisma.notification.updateMany({
      where: { id, organizationId: user.organizationId, userId: user.id, resolvedAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Notification not found.');
    return { id, read: true };
  }

  async getReviewerWorkload(user: AuthUser) {
    const [reviewers, activeAssignments] = await Promise.all([
      this.prisma.user.findMany({
        where: { organizationId: user.organizationId, role: 'REVIEWER' },
        select: { id: true, name: true, email: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.reviewAssignment.findMany({
        where: { organizationId: user.organizationId, status: 'ACTIVE' },
        select: { reviewerId: true },
      }),
    ]);
    const workload = new Map<string, number>();
    for (const assignment of activeAssignments) workload.set(assignment.reviewerId, (workload.get(assignment.reviewerId) ?? 0) + 1);
    return reviewers.map((reviewer) => ({ ...reviewer, activeAssignments: workload.get(reviewer.id) ?? 0 }));
  }

  async assignReviewer(id: string, user: AuthUser, reviewerId?: string) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!document) throw new NotFoundException('Document not found.');
    if (!['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'].includes(document.status)) {
      throw new BadRequestException('Only pending documents can be assigned for review.');
    }

    const workload = await this.getReviewerWorkload(user);
    if (!workload.length) throw new BadRequestException('No reviewers are available in this organization.');
    const chosenReviewer = reviewerId
      ? workload.find((reviewer) => reviewer.id === reviewerId)
      : [...workload].sort((left, right) => left.activeAssignments - right.activeAssignments || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))[0];
    if (!chosenReviewer) throw new BadRequestException('The selected user is not an eligible reviewer in this organization.');

    return this.prisma.$transaction(async (tx) => {
      await tx.reviewAssignment.updateMany({
        where: { organizationId: user.organizationId, documentId: id, status: 'ACTIVE' },
        data: { status: 'REASSIGNED', completedAt: new Date() },
      });
      const updatedDocument = await tx.document.update({
        where: { id },
        data: { assignedReviewerId: chosenReviewer.id },
      });
      await tx.reviewAssignment.create({
        data: {
          organizationId: user.organizationId,
          documentId: id,
          reviewerId: chosenReviewer.id,
          assignedById: user.id,
          status: 'ACTIVE',
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          documentId: id,
          action: 'DOCUMENT_REVIEWER_ASSIGNED',
          metadata: { reviewerId: chosenReviewer.id, reviewerName: chosenReviewer.name, assignmentMode: reviewerId ? 'MANUAL' : 'LEAST_LOADED' },
        },
      });
      return { ...updatedDocument, assignedReviewer: chosenReviewer, assignmentMode: reviewerId ? 'MANUAL' : 'LEAST_LOADED' };
    });
  }

  async findOne(id: string, user: AuthUser) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        assignedReviewer: { select: { id: true, name: true, email: true } },
        classification: true,
        extractedFields: { orderBy: { fieldName: 'asc' } },
        fraudAssessment: true,
      },
    });

    if (!document) {
      throw new NotFoundException('Document not found.');
    }

    return this.withReviewMetadata(document);
  }

  async getExtractedFields(id: string, user: AuthUser) {
    await this.findOne(id, user);
    return this.prisma.extractedField.findMany({ where: { documentId: id }, orderBy: { fieldName: 'asc' } });
  }

  async getDocumentClassification(id: string, user: AuthUser) {
    const document = await this.findOne(id, user);
    return (document as typeof document & { classification?: unknown }).classification ?? null;
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

  async getEscalationSummary(user: AuthUser) {
    const documents = await this.prisma.document.findMany({
      where: {
        organizationId: user.organizationId,
        status: { in: ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = Date.now();

    return documents
      .map((document) => {
        const riskScore = this.getDocumentRiskScore(document);
        const ageDays = Math.max(0, (now - new Date(document.createdAt).getTime()) / (24 * 60 * 60 * 1000));
        const lane = this.getRecommendedReviewLane(document, riskScore);
        const reviewer = this.getRecommendedReviewer(document, riskScore);
        const vendor = (document.vendorName ?? '').trim() || 'Unassigned vendor';

        const eligibleForEscalation = lane === 'FINANCE_REVIEW' || lane === 'BANKING_REVIEW' || lane === 'KYC_REVIEW' || riskScore >= 60;
        if (!eligibleForEscalation) {
          return null;
        }

        const thresholdDays = lane === 'FINANCE_REVIEW' ? 3 : lane === 'BANKING_REVIEW' ? 5 : lane === 'KYC_REVIEW' ? 4 : 2;
        if (ageDays < thresholdDays) {
          return null;
        }

        const severity: 'medium' | 'high' | 'critical' =
          riskScore >= 80 || ageDays >= 7 ? 'critical' : riskScore >= 60 || Number(document.totalAmount ?? 0) >= 50000 ? 'high' : 'medium';

        return {
          id: document.id,
          documentId: document.id,
          type: 'SLA_ESCALATION',
          severity,
          vendor,
          reviewer,
          lane,
          documentType: document.documentType ?? 'UNKNOWN',
          status: document.status,
          daysOpen: Number(ageDays.toFixed(1)),
          detail: `${vendor} has had a ${lane.replace(/_REVIEW$/, '').toLowerCase()} review pending for ${Number(ageDays.toFixed(1))} days.`,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((left, right) => {
        const severityWeight = { critical: 3, high: 2, medium: 1 } as const;
        return severityWeight[right.severity] - severityWeight[left.severity] || right.daysOpen - left.daysOpen;
      });
  }

  async getReviewAnalytics(user: AuthUser, periodDays = 7) {
    const normalizedPeriodDays = Number.isFinite(periodDays) ? Math.min(90, Math.max(1, Math.floor(periodDays))) : 7;
    const periodStart = new Date(Date.now() - normalizedPeriodDays * 24 * 60 * 60 * 1000);
    const documents = await this.prisma.document.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
      include: { fraudAssessment: true },
    });

    const periodDocuments = documents.filter((document) => new Date(document.createdAt).getTime() >= periodStart.getTime());
    const totalDocuments = periodDocuments.length;
    const approvedCount = periodDocuments.filter((document) => document.status === 'APPROVED').length;
    const reviewCount = periodDocuments.filter((document) => ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'].includes(document.status)).length;
    const approvalRate = totalDocuments > 0 ? Number(((approvedCount / totalDocuments) * 100).toFixed(0)) : 0;

    const riskBreakdown = periodDocuments.reduce(
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
      periodDocuments.reduce<Record<string, number>>((accumulator, document) => {
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

    // Duplicate invoices and vendor history are cross-period controls; keep their baselines across the full organization history.
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

    const vendorRiskMap = new Map<string, { count: number; highRiskCount: number; avgAmount: number; maxAmount: number }>();
    for (const document of documents) {
      const vendorName = (document.vendorName ?? '').trim();
      if (!vendorName) {
        continue;
      }

      const current = vendorRiskMap.get(vendorName) ?? { count: 0, highRiskCount: 0, avgAmount: 0, maxAmount: 0 };
      const riskScore = this.getDocumentRiskScore(document);
      const amount = Number(document.totalAmount ?? 0);
      vendorRiskMap.set(vendorName, {
        count: current.count + 1,
        highRiskCount: current.highRiskCount + (riskScore >= 60 ? 1 : 0),
        avgAmount: current.avgAmount + amount,
        maxAmount: Math.max(current.maxAmount, amount),
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

    const amountSpikeAlerts = [...vendorRiskMap.entries()]
      .map(([vendor, metrics]) => ({
        vendor,
        count: metrics.count,
        avgAmount: metrics.count ? metrics.avgAmount / metrics.count : 0,
        maxAmount: metrics.maxAmount,
      }))
      .filter((entry) => entry.count >= 3 && entry.avgAmount > 0 && entry.maxAmount >= Math.max(10000, entry.avgAmount * 2))
      .map((entry) => ({
        type: 'Amount spike risk',
        vendor: entry.vendor,
        severity: 'high' as const,
        detail: `An invoice spike for ${entry.vendor} reached ${entry.maxAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} versus an average of ${entry.avgAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}.`,
      }));

    const policyExceptions = [...duplicateInvoicePatterns, ...concentrationAlerts, ...amountSpikeAlerts].sort((left, right) => {
      const severityWeight = { high: 2, medium: 1 } as const;
      return severityWeight[right.severity] - severityWeight[left.severity];
    });

    const [escalations, reviewEventsResult] = await Promise.all([
      this.getEscalationSummary(user),
      this.prisma.auditLog.findMany({
        where: { organizationId: user.organizationId, action: 'DOCUMENT_REVIEWED', createdAt: { gte: periodStart } },
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, name: true, email: true } }, document: { select: { createdAt: true } } },
      }),
    ]);
    const reviewEvents = reviewEventsResult ?? [];

    const reviewerMetrics = new Map<string, {
      reviewerId: string | null; name: string; email: string; decisions: number; approved: number; rejected: number;
      needsReview: number; turnaroundTotalHours: number; turnaroundSamples: number; lastReviewedAt: Date;
    }>();
    for (const event of reviewEvents) {
      const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
        ? event.metadata as Record<string, unknown>
        : {};
      const reviewerEmail = typeof metadata.reviewerEmail === 'string' ? metadata.reviewerEmail : '';
      const key = event.userId ?? (reviewerEmail || 'unknown');
      const current = reviewerMetrics.get(key) ?? {
        reviewerId: event.userId ?? null,
        name: event.user?.name ?? (reviewerEmail || 'Former user'),
        email: event.user?.email ?? reviewerEmail,
        decisions: 0, approved: 0, rejected: 0, needsReview: 0,
        turnaroundTotalHours: 0, turnaroundSamples: 0, lastReviewedAt: event.createdAt,
      };
      current.decisions += 1;
      const decision = metadata.decision;
      if (decision === 'APPROVED') current.approved += 1;
      else if (decision === 'REJECTED') current.rejected += 1;
      else if (decision === 'REVIEW_REQUIRED') current.needsReview += 1;
      if (event.document?.createdAt) {
        const elapsedHours = (event.createdAt.getTime() - event.document.createdAt.getTime()) / (60 * 60 * 1000);
        if (elapsedHours >= 0) {
          current.turnaroundTotalHours += elapsedHours;
          current.turnaroundSamples += 1;
        }
      }
      if (event.createdAt > current.lastReviewedAt) current.lastReviewedAt = event.createdAt;
      reviewerMetrics.set(key, current);
    }
    const reviewerPerformance = [...reviewerMetrics.values()]
      .map((reviewer) => ({
        reviewerId: reviewer.reviewerId,
        name: reviewer.name,
        email: reviewer.email,
        decisions: reviewer.decisions,
        approved: reviewer.approved,
        rejected: reviewer.rejected,
        needsReview: reviewer.needsReview,
        averageDecisionHours: reviewer.turnaroundSamples
          ? Number((reviewer.turnaroundTotalHours / reviewer.turnaroundSamples).toFixed(1))
          : null,
        lastReviewedAt: reviewer.lastReviewedAt,
      }))
      .sort((left, right) => right.decisions - left.decisions || left.name.localeCompare(right.name));

    const now = new Date();
    const trendDates = Array.from({ length: normalizedPeriodDays }, (_, index) => {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      date.setUTCDate(date.getUTCDate() - (normalizedPeriodDays - 1 - index));
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
      periodDays: normalizedPeriodDays,
      totalDocuments,
      approvedCount,
      reviewCount,
      approvalRate,
      riskBreakdown,
      vendorRisk,
      agingSummary,
      policyExceptions,
      escalations,
      reviewerPerformance,
      dailyTrend,
      statusBreakdown: periodDocuments.reduce<Record<string, number>>((accumulator, document) => {
        accumulator[document.status] = (accumulator[document.status] ?? 0) + 1;
        return accumulator;
      }, {}),
      typeBreakdown: periodDocuments.reduce<Record<string, number>>((accumulator, document) => {
        const typeKey = document.documentType ?? 'UNKNOWN';
        accumulator[typeKey] = (accumulator[typeKey] ?? 0) + 1;
        return accumulator;
      }, {}),
    };
  }

  async exportReviewAnalytics(user: AuthUser, periodDays = 7) {
    const analytics = await this.getReviewAnalytics(user, periodDays);

    const [vendorRiskProfiles, reviewerWorkload, notifications] = await Promise.all([
      this.getVendorRiskProfiles(user),
      this.getReviewerWorkload(user),
      this.getNotifications(user),
    ]);
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
      ['escalations', JSON.stringify(analytics.escalations ?? [])],
      ['reviewerPerformance', JSON.stringify(analytics.reviewerPerformance)],
      ['vendorRisk', JSON.stringify(analytics.vendorRisk)],
      ['dailyTrend', JSON.stringify(analytics.dailyTrend)],
      ['vendorRiskProfiles', JSON.stringify(vendorRiskProfiles)],
      ['reviewerWorkload', JSON.stringify(reviewerWorkload)],
      ['unreadNotificationCount', String((notifications ?? []).filter((notification) => !notification.readAt).length)],
    ];

    const header = ['metric', 'value'];
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    return csv;
  }

  async enqueueDocumentProcessing(id: string, user: AuthUser) {
    const document = await this.prisma.document.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!document) throw new NotFoundException('Document not found.');
    if (!['UPLOADED', 'FAILED'].includes(document.status)) {
      throw new BadRequestException('Only uploaded or failed documents can be queued for processing.');
    }
    if (!this.processingQueue) throw new ServiceUnavailableException('Document processing queue is unavailable.');

    const existingJob = await this.prisma.processingJob.findFirst({
      where: { organizationId: user.organizationId, documentId: id, status: { in: ['QUEUED', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existingJob) return existingJob;

    const processingJob = await this.prisma.processingJob.create({
      data: { organizationId: user.organizationId, documentId: id, status: 'QUEUED', currentStep: 'QUEUED', progress: 0 },
    });
    try {
      await this.processingQueue.enqueue({ processingJobId: processingJob.id, documentId: id, user });
      await this.prisma.auditLog.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          documentId: id,
          action: 'PROCESSING_JOB_QUEUED',
          metadata: { processingJobId: processingJob.id },
        },
      });
      return processingJob;
    } catch (error) {
      await this.prisma.processingJob.update({
        where: { id: processingJob.id },
        data: { status: 'FAILED', currentStep: 'QUEUE_FAILED', error: 'Unable to enqueue processing job.', completedAt: new Date() },
      });
      throw error;
    }
  }

  async getDocumentProcessingStatus(id: string, user: AuthUser) {
    const document = await this.prisma.document.findFirst({ where: { id, organizationId: user.organizationId }, select: { id: true, status: true } });
    if (!document) throw new NotFoundException('Document not found.');
    const processingJob = await this.prisma.processingJob.findFirst({
      where: { documentId: id, organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return { documentId: id, documentStatus: document.status, processingJob };
  }

  private toInvoiceExtraction(fields: Record<string, { normalizedValue: string | null }>, requiresReview: boolean): InvoiceExtractionResult {
    const fieldValue = (name: string) => fields[name]?.normalizedValue ?? '';
    const parseDate = (value: string): Date | null => {
      const date = value ? new Date(value) : null;
      return !date || Number.isNaN(date.getTime()) ? null : date;
    };
    const total = Number(fieldValue('total'));
    return {
      vendorName: fieldValue('vendor_name'),
      invoiceNumber: fieldValue('invoice_number'),
      invoiceDate: parseDate(fieldValue('invoice_date')),
      dueDate: parseDate(fieldValue('due_date')),
      totalAmount: Number.isFinite(total) ? total : 0,
      currency: fieldValue('currency') || 'USD',
      requiresReview,
    };
  }

  async processDocument(id: string, user: AuthUser, processingJobId?: string) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId: user.organizationId },
    });

    if (!document) {
      throw new NotFoundException('Document not found.');
    }

    if (processingJobId) await this.updateProcessingProgress(processingJobId, 'TEXT_EXTRACTION', 20);
    const documentTextHint = await this.readDocumentTextHint(document.storagePath);
    if (processingJobId) await this.updateProcessingProgress(processingJobId, 'CLASSIFICATION_AND_EXTRACTION', 55);
    const pipelineResult = this.extractionPipeline.run(document.filename, documentTextHint, document.documentType);
    const documentType = pipelineResult.documentType;
    const extractedFields = pipelineResult.fields;
    const extraction = documentType === 'INVOICE' ? this.toInvoiceExtraction(extractedFields, pipelineResult.missingRequiredFields.length > 0) : null;
    const validation = documentType === 'INVOICE' ? this.validateInvoice(extraction ?? { vendorName: '', invoiceNumber: '', totalAmount: 0, currency: 'USD' }) : { requiresReview: false, flags: [], riskScore: 0 };
    const confidenceFlags = pipelineResult.missingRequiredFields.map((fieldName) => `Missing or low-confidence required field: ${fieldName}`);
    if (documentType === 'UNKNOWN' || pipelineResult.classification.confidence < Number(process.env.FIELD_REVIEW_CONFIDENCE ?? 0.7)) {
      confidenceFlags.push('Document classification confidence is too low for automatic routing');
    }
    const complianceFlags = documentType === 'INVOICE' ? await this.detectDuplicateInvoiceFlags(user.organizationId, document.id, extraction?.vendorName ?? document.vendorName, extraction?.invoiceNumber ?? document.invoiceNumber) : [];
    const combinedFlags = [...new Set([...validation.flags, ...confidenceFlags, ...complianceFlags])];
    if (processingJobId) await this.updateProcessingProgress(processingJobId, 'VALIDATION_AND_ROUTING', 85);
    const combinedRiskScore = Math.min(100, validation.riskScore + complianceFlags.length * 25 + confidenceFlags.length * 10);
    const nextStatus = document.status === 'UPLOADED' ? 'PROCESSING' : document.status === 'PROCESSING' ? 'EXTRACTED' : document.status;
    const reviewStatus = combinedFlags.length > 0 || validation.requiresReview || extraction?.requiresReview ? 'REVIEW_REQUIRED' : nextStatus;

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
        extractedAt: new Date(),
        extractedText: documentTextHint || null,
      },
    });

    await this.prisma.documentClassification.upsert({
      where: { documentId: id },
      create: { documentId: id, documentType, confidence: pipelineResult.classification.confidence, provider: this.extractionPipeline.providerName, rawOutput: { declaredType: document.documentType, inferredType: pipelineResult.classification.documentType } },
      update: { documentType, confidence: pipelineResult.classification.confidence, provider: this.extractionPipeline.providerName, rawOutput: { declaredType: document.documentType, inferredType: pipelineResult.classification.documentType }, classifiedAt: new Date() },
    });
    await Promise.all(Object.entries(extractedFields).map(([fieldName, field]) => this.prisma.extractedField.upsert({
      where: { documentId_fieldName: { documentId: id, fieldName } },
      create: { documentId: id, fieldName, value: field.value, normalizedValue: field.normalizedValue, confidence: field.confidence, source: field.source },
      update: { value: field.value, normalizedValue: field.normalizedValue, confidence: field.confidence, source: field.source },
    })));
    if (documentType === 'INVOICE' && this.prisma.fraudAssessment) {
      const documents = await this.prisma.document.findMany({ where: { organizationId: user.organizationId, documentType: 'INVOICE' }, orderBy: { createdAt: 'asc' } });
      const assessedDocument = documents.find((item) => item.id === id) ?? updatedDocument;
      await this.assessFraudDocument(assessedDocument, documents);
    }

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

        await this.prisma.reviewAssignment.updateMany({
          where: { organizationId: user.organizationId, documentId: document.id, status: 'ACTIVE' },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
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

    await this.prisma.reviewAssignment.updateMany({
      where: { organizationId: user.organizationId, documentId: id, status: 'ACTIVE' },
      data: { status: 'COMPLETED', completedAt: new Date() },
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

  private withReviewMetadata<T extends { id: string; documentType?: string | null; status?: string | null; totalAmount?: number | null; vendorName?: string | null }>(document: T) {
    const baseRiskScore = this.getDocumentRiskScore(document as any);
    const fraudScore = Number((document as any).fraudAssessment?.score ?? 0);
    const riskScore = Math.min(100, Math.max(baseRiskScore, fraudScore));
    const reviewLane = this.getRecommendedReviewLane(document as any, riskScore);

    return {
      ...document,
      riskScore,
      recommendedReviewLane: reviewLane,
      recommendedReviewer: this.getRecommendedReviewer(document as any, riskScore),
      assignedReviewerId: (document as any).assignedReviewerId ?? null,
      assignedReviewer: (document as any).assignedReviewer ?? null,
    };
  }

  private getRecommendedReviewLane(
    document: Partial<{ documentType?: string | null; status?: string | null; totalAmount?: number | null; vendorName?: string | null }>,
    riskScore: number,
  ): string {
    if (document.documentType === 'BANK_STATEMENT' || /bank statement|statement/i.test(String(document.documentType ?? ''))) {
      return 'BANKING_REVIEW';
    }

    if (document.documentType === 'KYC' || /kyc|identity/i.test(String(document.documentType ?? ''))) {
      return 'KYC_REVIEW';
    }

    if (document.documentType === 'INVOICE' || Number(document.totalAmount ?? 0) >= 50000 || riskScore >= 60) {
      return 'FINANCE_REVIEW';
    }

    if (document.documentType === 'COMPLIANCE_REPORT' || riskScore >= 70) {
      return 'COMPLIANCE_REVIEW';
    }

    return 'GENERAL_REVIEW';
  }

  private getRecommendedReviewer(
    document: Partial<{ documentType?: string | null; status?: string | null; totalAmount?: number | null; vendorName?: string | null }>,
    riskScore: number,
  ): string {
    const lane = this.getRecommendedReviewLane(document, riskScore);

    if (lane === 'BANKING_REVIEW') {
      return 'Nina Patel';
    }

    if (lane === 'KYC_REVIEW') {
      return 'Alicia Gomez';
    }

    if (lane === 'COMPLIANCE_REVIEW') {
      return 'Daniel Brooks';
    }

    if (lane === 'FINANCE_REVIEW') {
      return 'Maya Chen';
    }

    return 'Operations Desk';
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
            normalizedVendor.startsWith(candidateVendor) ||
            candidateVendor.includes(normalizedVendor) ||
            normalizedVendor.includes(candidateVendor))
        );

        if (!normalizedVendor || !candidateVendor || isSameVendor) {
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

        const extractedImageText = await this.extractImageTextWithOcr(absolutePath);
        if (extractedImageText) {
          return extractedImageText.slice(0, 20000);
        }
      }

      if (['.png', '.jpg', '.jpeg'].includes(extension)) {
        const extractedImageText = await this.extractImageTextWithOcr(absolutePath);
        if (extractedImageText) {
          return extractedImageText.slice(0, 20000);
        }
      }

      const decoded = fileBuffer.toString('latin1');
      return decoded.replace(/\0/g, ' ').replace(/[^\x20-\x7E\r\n]/g, ' ').slice(0, 20000);
    } catch {
      return '';
    }
  }

  private async extractImageTextWithOcr(filePath: string): Promise<string> {
    const binaryCandidates = [process.env.TESSERACT_PATH?.trim(), 'tesseract'].filter(Boolean) as string[];
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ledgerflow-ocr-'));

    try {
      const isPdf = path.extname(filePath).toLowerCase() === '.pdf';
      let pagePaths = [filePath];

      // Render a bounded number of pages at print resolution; Tesseract expects images.
      if (isPdf) {
        const renderedPrefix = path.join(temporaryDirectory, 'page');
        const renderers = [process.env.PDFTOPPM_PATH?.trim(), 'pdftoppm'].filter(Boolean) as string[];
        let rendered = false;
        for (const binary of renderers) {
          try {
            await this.runOcrCommand(binary, ['-f', '1', '-l', process.env.OCR_PDF_MAX_PAGES?.trim() || '10', '-r', process.env.OCR_PDF_DPI?.trim() || '300', '-png', filePath, renderedPrefix], {
              stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
            });
            rendered = true;
            break;
          } catch {
            // Try another configured/local renderer.
          }
        }
        if (!rendered) return '';
        pagePaths = (await fs.readdir(temporaryDirectory))
          .filter((name) => /^page-\d+\.png$/i.test(name))
          .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
          .map((name) => path.join(temporaryDirectory, name));
      }

      const extractedPages: string[] = [];
      for (let pageIndex = 0; pageIndex < pagePaths.length; pageIndex += 1) {
        const sourcePath = pagePaths[pageIndex];
        if (!sourcePath) continue;
        const enhancedPath = process.env.OCR_PREPROCESSING_ENABLED === 'false'
          ? null
          : await this.preprocessOcrImage(sourcePath, temporaryDirectory, pageIndex);
        const ocrInputs = enhancedPath ? [enhancedPath, sourcePath] : [sourcePath];
        let bestText = '';

        for (const imagePath of ocrInputs) {
          for (const psm of ['6', '11']) {
            for (const binary of binaryCandidates) {
              try {
                const output = await this.runOcrCommand(binary, [imagePath, 'stdout', '--oem', process.env.TESSERACT_OEM?.trim() || '1', '--psm', psm, '-l', process.env.TESSERACT_LANGUAGES?.trim() || 'eng'], {
                  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 5 * 1024 * 1024,
                });
                const cleaned = String(output ?? '').replace(/\s+/g, ' ').trim();
                if (this.countOcrCharacters(cleaned) > this.countOcrCharacters(bestText)) bestText = cleaned;
              } catch {
                // Try a different segmentation mode or configured Tesseract binary.
              }
            }
          }
        }
        if (bestText) extractedPages.push(bestText);
      }
      return extractedPages.join('\n').slice(0, 20000);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async preprocessOcrImage(filePath: string, temporaryDirectory: string, pageIndex: number): Promise<string | null> {
    const outputPath = path.join(temporaryDirectory, `enhanced-${pageIndex}.png`);
    const processors = [process.env.OCR_IMAGE_PROCESSOR_PATH?.trim(), 'magick', 'convert'].filter(Boolean) as string[];
    const adjustments = ['-colorspace', 'Gray', '-deskew', '40%', '-normalize', '-contrast-stretch', '1%x1%', '-sharpen', '0x1'];

    for (const binary of processors) {
      try {
        const args = path.basename(binary).toLowerCase() === 'magick'
          ? ['convert', filePath, ...adjustments, outputPath]
          : [filePath, ...adjustments, outputPath];
        await this.runOcrCommand(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
        return outputPath;
      } catch {
        // ImageMagick is optional; continue with the original image if unavailable.
      }
    }
    return null;
  }

  private runOcrCommand(binary: string, args: string[], options: any): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
      execFile(binary, args, options, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }

  private async updateProcessingProgress(processingJobId: string, currentStep: string, progress: number): Promise<void> {
    await this.prisma.processingJob.update({ where: { id: processingJobId }, data: { currentStep, progress } });
  }

  private countOcrCharacters(value: string): number {
    return (value.match(/[\p{L}\p{N}]/gu) ?? []).length;
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
    fraudAssessment?: { score?: number | null } | null;
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

    return Math.min(100, Math.max(riskScore, Number(document.fraudAssessment?.score ?? 0)));
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

  private detectDocumentTypeFromContent(contentHint: string, filename: string): 'INVOICE' | 'BANK_STATEMENT' | 'KYC' | 'COMPLIANCE_REPORT' | 'UNKNOWN' {
    const normalized = `${contentHint} ${filename}`.toLowerCase();

    if (/(invoice|bill|payment due|amount due|vendor)/i.test(normalized)) {
      return 'INVOICE';
    }
    if (/(bank(?:\s+of\s+america)?\s+statement|account summary|transaction history|balance as of|ending in \d{4}|statement\s+account)/i.test(normalized)) {
      return 'BANK_STATEMENT';
    }
    if (/(kyc|know your customer|identity verification|passport|driver license|address verification)/i.test(normalized)) {
      return 'KYC';
    }
    if (/(compliance report|policy review|risk assessment|audit report|regulatory review)/i.test(normalized)) {
      return 'COMPLIANCE_REPORT';
    }

    return this.detectDocumentType(filename);
  }

  private safeFilename(filename: string): string {
    return filename.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 180) || 'document';
  }
}
