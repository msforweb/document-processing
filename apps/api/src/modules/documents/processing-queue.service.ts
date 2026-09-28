import { Injectable, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { AuthUser } from '../../types/auth-user';

export const DOCUMENT_PROCESSING_QUEUE = 'document-processing';

export type DocumentProcessingTask = {
  processingJobId: string;
  documentId: string;
  user: AuthUser;
};

export function getRedisConnectionOptions(): Record<string, unknown> {
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const options: Record<string, unknown> = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || (redisUrl.protocol === 'rediss:' ? 6380 : 6379)),
    maxRetriesPerRequest: null,
  };
  if (redisUrl.username) options.username = decodeURIComponent(redisUrl.username);
  if (redisUrl.password) options.password = decodeURIComponent(redisUrl.password);
  if (redisUrl.pathname.length > 1) options.db = Number(redisUrl.pathname.slice(1));
  if (redisUrl.protocol === 'rediss:') options.tls = {};
  return options;
}

@Injectable()
export class ProcessingQueueService implements OnModuleInit, OnModuleDestroy {
  private queue?: Queue<DocumentProcessingTask>;

  async onModuleInit(): Promise<void> {
    this.queue = new Queue<DocumentProcessingTask>(DOCUMENT_PROCESSING_QUEUE, {
      connection: getRedisConnectionOptions() as never,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 5_000 },
      },
    });
    await this.queue.waitUntilReady();
  }

  async enqueue(task: DocumentProcessingTask): Promise<void> {
    if (!this.queue) throw new ServiceUnavailableException('Document processing queue is not ready.');
    await this.queue.add('process-document', task, { jobId: task.processingJobId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
