import { BadRequestException, Injectable } from '@nestjs/common';

type DocumentInsightContext = {
  filename?: string;
  documentType?: string;
  status?: string;
  vendorName?: string | null;
  invoiceNumber?: string | null;
  totalAmount?: number | string | null;
  currency?: string | null;
  validationFlags?: string[];
  riskScore?: number;
  summary?: string;
};

@Injectable()
export class AiService {
  buildDocumentInsight(document: DocumentInsightContext) {
    const flags = document.validationFlags ?? [];
    const riskScore = Number(document.riskScore ?? 0);
    const hasHighRiskSignal = riskScore >= 70 || flags.some((flag) => /placeholder|generic test|short due|future date|large invoice/i.test(flag));

    let riskLevel: 'Low' | 'Medium' | 'High' = 'Low';
    if (riskScore >= 70 || hasHighRiskSignal) {
      riskLevel = 'High';
    } else if (riskScore >= 40 || flags.length > 0) {
      riskLevel = 'Medium';
    }

    let recommendation = 'Approve';
    let suggestedAction = 'Proceed with standard approval and maintain normal audit checks.';

    if (riskLevel === 'High') {
      recommendation = 'Manual review required';
      suggestedAction = 'Escalate to reviewer and request vendor verification before approval.';
    } else if (riskLevel === 'Medium') {
      recommendation = 'Approval with caution';
      suggestedAction = 'Review the extracted fields, verify payment terms, and confirm the vendor match.';
    }

    const explanation = [
      `The ${document.documentType ?? 'document'} ${document.filename ?? 'record'} is currently marked as ${document.status ?? 'unknown'}.`,
      flags.length
        ? `The main concerns are: ${flags.slice(0, 3).join('; ')}.`
        : 'No material validation flags were recorded for this document.',
      `Current risk score: ${riskScore}/100. ${suggestedAction}`,
    ].join(' ');

    return {
      riskLevel,
      recommendation,
      suggestedAction,
      explanation,
    };
  }

  async chat(message: string) {
    const trimmedMessage = message?.trim();

    if (!trimmedMessage) {
      throw new BadRequestException('A message is required.');
    }

    const baseUrl = (process.env.AI_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const apiKey = process.env.AI_API_KEY?.trim();
    const model = process.env.AI_MODEL?.trim() || 'openai/gpt-4o-mini';

    if (!apiKey) {
      return {
        configured: false,
        model,
        message: trimmedMessage,
        reply:
          'AI integration is not configured yet. Add AI_API_KEY, AI_BASE_URL, and AI_MODEL to your .env file to enable OpenRouter responses.',
      };
    }

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'http://localhost:5173',
          'X-Title': 'LedgerFlow Document Processing',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You are a helpful assistant for a document processing and operations platform. Be concise, practical, and use business-friendly language.',
            },
            { role: 'user', content: trimmedMessage },
          ],
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new BadRequestException(`AI request failed: ${errorText}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const reply = payload.choices?.[0]?.message?.content?.trim() || 'No response returned from the model.';

      return {
        configured: true,
        model,
        message: trimmedMessage,
        reply,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      const messageText = error instanceof Error ? error.message : 'Unexpected AI error.';
      throw new BadRequestException(`Unable to process AI chat request: ${messageText}`);
    }
  }
}
