import type { DocumentType } from '@prisma/client';

export type ClassifiedDocument = { documentType: DocumentType; confidence: number };
export type ExtractedValue = { value: string | null; confidence: number; source: string };
export type ExtractedValues = Record<string, ExtractedValue>;

export interface DocumentAiProvider {
  readonly name: string;
  classifyDocument(filename: string, text: string): ClassifiedDocument | Promise<ClassifiedDocument>;
  extractFields(documentType: DocumentType, text: string, filename: string): ExtractedValues | Promise<ExtractedValues>;
}

export const DOCUMENT_AI_PROVIDER = Symbol('DOCUMENT_AI_PROVIDER');
