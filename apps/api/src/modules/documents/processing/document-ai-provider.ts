import type { DocumentType } from '@prisma/client';

export type ClassifiedDocument = { documentType: DocumentType; confidence: number };
export type ExtractedValue = { value: string | null; confidence: number; source: string };
export type ExtractedValues = Record<string, ExtractedValue>;

export interface DocumentAiProvider {
  readonly name: string;
  classifyDocument(filename: string, text: string): ClassifiedDocument;
  extractFields(documentType: DocumentType, text: string, filename: string): ExtractedValues;
}
