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
import { EscalationScheduler } from './escalation.scheduler';
import { NotificationDeliveryService } from './notification-delivery.service';

@Module({
  imports: [AuthModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentsProcessor, ProcessingQueueService, EscalationScheduler, NotificationDeliveryService, LocalDocumentAiProvider, LocalStorageService, RolesGuard, JwtAuthGuard],
  exports: [DocumentsService],
})
export class DocumentsModule {}
