import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
  ) {
    return this.documentsService.getReviewQueue(user, {
      status: status || undefined,
      documentType: documentType || undefined,
      onlyHighRisk: onlyHighRisk === 'true' || onlyHighRisk === '1',
    });
  }

  @Get('dashboard')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async getDashboardSummary(@CurrentUser() user: AuthUser) {
    return this.documentsService.getDashboardSummary(user);
  }

  @Get(':id')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.findOne(id, user);
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

  @Post(':id/process')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async processDocument(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.processDocument(id, user);
  }

  @Post(':id/review')
  @Roles('ADMIN', 'REVIEWER')
  @UseGuards(RolesGuard)
  async reviewDocument(
    @Param('id') id: string,
    @Body('decision') decision: 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED',
    @Body('note') note: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!decision) {
      throw new BadRequestException('A review decision is required.');
    }

    return this.documentsService.reviewDocument(id, decision, user, note);
  }
}
