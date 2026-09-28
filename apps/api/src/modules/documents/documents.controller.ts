import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import type { AuthUser } from '../../types/auth-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DocumentsService } from './documents.service';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documentsService: DocumentsService) {}

  @Post('upload')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024,
      },
      fileFilter: (_req, file, callback) => {
        const allowedMimeTypes = ['application/pdf', 'image/png', 'image/jpeg'];

        if (allowedMimeTypes.includes(file.mimetype)) {
          callback(null, true);
          return;
        }

        callback(new BadRequestException('Only PDF, PNG, JPG, and JPEG files are allowed.'), false);
      },
    }),
  )
  async upload(
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: AuthUser,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required.');
    }

    return this.documentsService.upload(files, user);
  }

  @Get()
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async findAll(@CurrentUser() user: AuthUser) {
    return this.documentsService.list(user);
  }

  @Get('review-queue')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getReviewQueue(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('documentType') documentType?: string,
    @Query('onlyHighRisk') onlyHighRisk?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.documentsService.getReviewQueue(user, {
      ...(status ? { status } : {}),
      ...(documentType ? { documentType } : {}),
      onlyHighRisk: onlyHighRisk === 'true' || onlyHighRisk === '1',
      ...(search ? { search } : {}),
      ...(page ? { page: Number(page) } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="review-queue.csv"')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async exportReviewQueue(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('documentType') documentType?: string,
    @Query('onlyHighRisk') onlyHighRisk?: string,
    @Query('search') search?: string,
  ) {
    return this.documentsService.exportReviewQueue(user, {
      ...(status ? { status } : {}),
      ...(documentType ? { documentType } : {}),
      onlyHighRisk: onlyHighRisk === 'true' || onlyHighRisk === '1',
      ...(search ? { search } : {}),
    });
  }

  @Get('vendor-risk')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getVendorRiskProfiles(@CurrentUser() user: AuthUser) {
    return this.documentsService.getVendorRiskProfiles(user);
  }

  @Post('vendor-risk/recalculate')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async recalculateVendorRiskProfiles(@CurrentUser() user: AuthUser) {
    return this.documentsService.recalculateVendorRiskProfiles(user);
  }

  @Post('fraud-assessments/recalculate')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async recalculateFraudAssessments(@CurrentUser() user: AuthUser) {
    return this.documentsService.recalculateFraudAssessments(user);
  }

  @Post('escalations/evaluate')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async evaluateEscalations(@CurrentUser() user: AuthUser) {
    return this.documentsService.evaluateEscalations(user);
  }

  @Get('notifications')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getNotifications(@CurrentUser() user: AuthUser) {
    return this.documentsService.getNotifications(user);
  }

  @Post('notifications/:id/read')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async markNotificationRead(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.markNotificationRead(id, user);
  }

  @Get('reviewer-workload')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getReviewerWorkload(@CurrentUser() user: AuthUser) {
    return this.documentsService.getReviewerWorkload(user);
  }

  @Get('dashboard')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getDashboardSummary(@CurrentUser() user: AuthUser) {
    return this.documentsService.getDashboardSummary(user);
  }

  @Get('analytics')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getReviewAnalytics(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    return this.documentsService.getReviewAnalytics(user, days ? Number(days) : 7);
  }

  @Get('escalations')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getEscalations(@CurrentUser() user: AuthUser) {
    return this.documentsService.getEscalationSummary(user);
  }

  @Get('analytics/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="review-analytics.csv"')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async exportReviewAnalytics(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    return this.documentsService.exportReviewAnalytics(user, days ? Number(days) : 7);
  }

  @Get(':id/status')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getDocumentProcessingStatus(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.getDocumentProcessingStatus(id, user);
  }

  @Get(':id')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.findOne(id, user);
  }

  @Get(':id/extracted-fields')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getExtractedFields(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.getExtractedFields(id, user);
  }

  @Get(':id/classification')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getDocumentClassification(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.getDocumentClassification(id, user);
  }

  @Get(':id/fraud-assessment')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getFraudAssessment(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.getFraudAssessment(id, user);
  }

  @Get(':id/summary')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async summarizeDocument(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.summarizeDocument(id, user);
  }

  @Get(':id/audit-log')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getDocumentAuditTrail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.getDocumentAuditTrail(id, user);
  }

  @Get(':id/audit-log/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="document-audit-log.csv"')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async exportDocumentAuditTrail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.exportDocumentAuditTrail(id, user);
  }

  @Post(':id/assign')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async assignReviewer(@Param('id') id: string, @Body('reviewerId') reviewerId: string | undefined, @CurrentUser() user: AuthUser) {
    return this.documentsService.assignReviewer(id, user, reviewerId);
  }

  @Post(':id/process')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async processDocument(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.enqueueDocumentProcessing(id, user);
  }

  @Post('bulk-review')
  @Roles('ADMIN', 'REVIEWER')
  @UseGuards(RolesGuard)
  async bulkReviewDocuments(
    @Body('documentIds') documentIds: string[],
    @Body('decision') decision: 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED',
    @Body('note') note: string | undefined,
    @Body('reason') reason: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!decision) {
      throw new BadRequestException('A review decision is required.');
    }

    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      throw new BadRequestException('At least one document ID is required.');
    }

    return this.documentsService.bulkReviewDocuments(documentIds, decision, user, note, reason);
  }

  @Post(':id/review')
  @Roles('ADMIN', 'REVIEWER')
  @UseGuards(RolesGuard)
  async reviewDocument(
    @Param('id') id: string,
    @Body('decision') decision: 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED',
    @Body('note') note: string | undefined,
    @Body('reason') reason: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!decision) {
      throw new BadRequestException('A review decision is required.');
    }

    return this.documentsService.reviewDocument(id, decision, user, note, reason);
  }
}
