import {
  Body,
  Controller,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiService } from './ai.service';

class ChatRequestDto {
  @IsString()
  @IsNotEmpty()
  message!: string;
}

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    @Inject(AiService)
    private readonly aiService: AiService,
  ) {}

  @Post('chat')
  @Roles('ADMIN', 'OPERATOR', 'REVIEWER')
  @UseGuards(RolesGuard)
  async chat(@Body() dto: ChatRequestDto) {
    return this.aiService.chat(dto.message);
  }
}
