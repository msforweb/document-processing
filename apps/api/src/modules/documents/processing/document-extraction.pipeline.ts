import type { DocumentType } from '@prisma/client';
import { ClassifiedDocument, DocumentAiProvider, ExtractedValue, ExtractedValues } from './document-ai-provider';
import { DOCUMENT_SCHEMAS } from './document-schemas';

export type NormalizedField = ExtractedValue & { normalizedValue: string | null };
export type DocumentPipelineResult = {
  classification: ClassifiedDocument;
  documentType: DocumentType;
  fields: Record<string, NormalizedField>;
  missingRequiredFields: string[];
};

export class DocumentExtractionPipeline {
  constructor(private readonly provider: DocumentAiProvider) {}

  get providerName(): string {
    return this.provider.name;
  }

  async run(filename: string, text: string, declaredType: DocumentType): Promise<DocumentPipelineResult> {
    const inferredClassification = await this.provider.classifyDocument(filename, text);
    const classified = declaredType === 'UNKNOWN'
      ? inferredClassification
      : { documentType: declaredType, confidence: 1 };
    const documentType = classified.documentType;
    const schema = DOCUMENT_SCHEMAS[documentType];
    const extracted = await this.provider.extractFields(documentType, text, filename);
    const fields: Record<string, NormalizedField> = {};
    for (const name of schema.fields) {
      const value = extracted[name] ?? { value: null, confidence: 0, source: 'not_found' };
      fields[name] = { ...value, normalizedValue: this.normalize(name, value.value, schema.dates, schema.numbers) };
    }
    const missingRequiredFields = schema.required.filter((name) => {
      const field = fields[name];
      return !field?.normalizedValue || field.confidence < Number(process.env.FIELD_REVIEW_CONFIDENCE ?? 0.7);
    });
    return { classification: classified, documentType, fields, missingRequiredFields };
  }

  private normalize(fieldName: string, value: string | null, dates: string[], numbers: string[]): string | null {
    if (value === null || !value.trim()) return null;
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (numbers.includes(fieldName)) {
      const normalized = cleaned.replace(/[^\d.-]/g, '');
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? String(parsed) : null;
    }
    if (fieldName === 'currency') return cleaned.toUpperCase();
    if (dates.includes(fieldName)) {
      const parsed = new Date(cleaned);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
    }
    return cleaned;
  }
}
