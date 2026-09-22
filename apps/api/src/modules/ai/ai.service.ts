import { BadRequestException, Injectable } from '@nestjs/common';

@Injectable()
export class AiService {
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
