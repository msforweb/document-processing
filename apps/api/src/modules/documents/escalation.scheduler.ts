import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DocumentsService } from './documents.service';

@Injectable()
export class EscalationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EscalationScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly documentsService: DocumentsService) {}

  onModuleInit(): void {
    if (process.env.ESCALATION_EVALUATION_ENABLED === 'false') {
      this.logger.log('Scheduled SLA escalation evaluation is disabled.');
      return;
    }

    const configuredInterval = Number(process.env.ESCALATION_EVALUATION_INTERVAL_MS ?? 300_000);
    const intervalMs = Number.isFinite(configuredInterval) ? Math.max(60_000, configuredInterval) : 300_000;
    void this.evaluate();
    this.timer = setInterval(() => void this.evaluate(), intervalMs);
    this.timer.unref();
    this.logger.log(`Scheduled SLA escalation evaluation every ${Math.round(intervalMs / 1000)} seconds.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async evaluate(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.documentsService.evaluateEscalationsForAllOrganizations();
      if (result.evaluated > 0) {
        this.logger.log(`Evaluated ${result.evaluated} escalations across ${result.organizations} organizations.`);
      }
    } catch (error) {
      this.logger.error('Scheduled SLA escalation evaluation failed.', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }
}
