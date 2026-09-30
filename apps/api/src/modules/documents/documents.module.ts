import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../../common/guards/roles.guard';
import { LocalStorageService } from '../../storage/local-storage.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentsProcessor } from './documents.processor';
import { ProcessingQueueService } from './processing-queue.service';
import { LocalDocumentAiProvider } from './processing/local-document-ai.provider';
import { DOCUMENT_AI_PROVIDER, type DocumentAiProvider } from './processing/document-ai-provider';
import { OpenAICompatibleDocumentAiProvider } from './processing/openai-compatible-document-ai.provider';
import { EscalationScheduler } from './escalation.scheduler';
import { NotificationDeliveryService } from './notification-delivery.service';

@Module({
  imports: [AuthModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    DocumentsProcessor,
    ProcessingQueueService,
    EscalationScheduler,
    NotificationDeliveryService,
    LocalDocumentAiProvider,
    OpenAICompatibleDocumentAiProvider,
    LocalStorageService,
    RolesGuard,
    JwtAuthGuard,
    {
      provide: DOCUMENT_AI_PROVIDER,
      useFactory: (
        local: LocalDocumentAiProvider,
        openai: OpenAICompatibleDocumentAiProvider,
      ): DocumentAiProvider =>
        process.env.AI_BASE_URL?.trim() &&
        process.env.AI_API_KEY?.trim() &&
        process.env.AI_MODEL?.trim()
          ? openai
          : local,
      inject: [LocalDocumentAiProvider, OpenAICompatibleDocumentAiProvider],
    },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
