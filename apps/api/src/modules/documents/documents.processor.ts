import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentsService } from './documents.service';
import { DOCUMENT_PROCESSING_QUEUE, DocumentProcessingTask, getRedisConnectionOptions } from './processing-queue.service';

@Injectable()
export class DocumentsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentsProcessor.name);
  private worker?: Worker<DocumentProcessingTask>;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DocumentsService) private readonly documentsService: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<DocumentProcessingTask>(
      DOCUMENT_PROCESSING_QUEUE,
      async (job: Job<DocumentProcessingTask>) => {
        const { processingJobId, documentId, user } = job.data;
        await this.prisma.processingJob.update({
          where: { id: processingJobId },
          data: { status: 'ACTIVE', currentStep: 'STARTING', progress: 5, startedAt: new Date(), error: null },
        });
        await this.prisma.document.update({ where: { id: documentId }, data: { status: 'PROCESSING' } });
        await this.documentsService.processDocument(documentId, user, processingJobId);
        await this.prisma.processingJob.update({
          where: { id: processingJobId },
          data: { status: 'COMPLETED', currentStep: 'COMPLETED', progress: 100, completedAt: new Date(), error: null },
        });
        return { documentId, status: 'COMPLETED' };
      },
      {
        connection: getRedisConnectionOptions() as never,
        concurrency: Math.max(1, Number(process.env.DOCUMENT_PROCESSING_CONCURRENCY ?? 2)),
      },
    );

    this.worker.on('failed', (job, error) => {
      if (!job) return;
      void this.recordFailure(job, error).catch((failure) => {
        this.logger.error(`Failed to record processing error for job ${job.id}: ${String(failure)}`);
      });
    });
    this.worker.on('error', (error) => this.logger.error(`Document processing worker error: ${error.message}`));
  }

  private async recordFailure(job: Job<DocumentProcessingTask>, error: Error): Promise<void> {
    const { processingJobId, documentId, user } = job.data;
    const attempts = Number(job.opts.attempts ?? 1);
    const exhausted = job.attemptsMade >= attempts;
    await this.prisma.processingJob.update({
      where: { id: processingJobId },
      data: {
        status: exhausted ? 'FAILED' : 'QUEUED',
        currentStep: exhausted ? 'FAILED' : 'RETRYING',
        error: error.message.slice(0, 2_000),
        ...(exhausted ? { completedAt: new Date() } : {}),
      },
    });
    if (exhausted) {
      await this.prisma.document.update({ where: { id: documentId }, data: { status: 'FAILED' } });
      await this.prisma.auditLog.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          documentId,
          action: 'DOCUMENT_PROCESSING_FAILED',
          metadata: { processingJobId, error: error.message.slice(0, 500), attempts: job.attemptsMade },
        },
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
