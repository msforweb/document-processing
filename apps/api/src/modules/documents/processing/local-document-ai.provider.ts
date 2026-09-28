import { Injectable } from '@nestjs/common';
import type { DocumentType } from '@prisma/client';
import { ClassifiedDocument, DocumentAiProvider, ExtractedValue, ExtractedValues } from './document-ai-provider';
import { DOCUMENT_SCHEMAS } from './document-schemas';

@Injectable()
export class LocalDocumentAiProvider implements DocumentAiProvider {
  readonly name = 'local-regex-v1';

  classifyDocument(filename: string, text: string): ClassifiedDocument {
    const content = `${filename}\n${text}`.toLowerCase();
    const rules: Array<{ type: DocumentType; pattern: RegExp; confidence: number }> = [
      { type: 'BANK_STATEMENT', pattern: /bank(?: of america)? statement|account summary|transaction history|opening balance|closing balance/, confidence: 0.92 },
      { type: 'KYC', pattern: /know your customer|identity verification|passport|driver'?s license|date of birth|document number/, confidence: 0.88 },
      { type: 'COMPLIANCE_REPORT', pattern: /compliance report|risk assessment|regulatory review|policy exception/, confidence: 0.9 },
      { type: 'INVOICE', pattern: /invoice|bill to|amount due|payment due|subtotal|tax total/, confidence: 0.9 },
    ];
    const winner = rules.find((rule) => rule.pattern.test(content));
    return winner ? { documentType: winner.type, confidence: winner.confidence } : { documentType: 'UNKNOWN', confidence: 0.25 };
  }

  extractFields(documentType: DocumentType, text: string, filename: string): ExtractedValues {
    const values: ExtractedValues = {};
    const content = text;
    const add = (name: string, pattern: RegExp, confidence = 0.84): void => {
      const match = content.match(pattern);
      values[name] = match?.[1] ? { value: match[1].trim(), confidence, source: 'text' } : { value: null, confidence: 0, source: 'not_found' };
    };
    const addFirstLine = (name: string, confidence = 0.6): void => {
      const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 2 && !/invoice|statement|report/i.test(part));
      values[name] = line ? { value: line.slice(0, 120), confidence, source: 'text_heuristic' } : { value: null, confidence: 0, source: 'not_found' };
    };

    if (documentType === 'INVOICE') {
      add('vendor_name', /(?:vendor|supplier|from|merchant)\s*[:#-]?\s*([^\n,]{2,100})/i);
      if (!values.vendor_name?.value) addFirstLine('vendor_name', 0.58);
      add('invoice_number', /(?:invoice\s*(?:number|no\.?|#)|inv\.?\s*#)\s*[:#-]\s*([A-Z0-9][A-Z0-9/_-]{2,})/i);
      add('invoice_date', /(?:invoice\s+date|issued\s+on|date)\s*[:#-]?\s*([^\n,]{4,30})/i);
      add('due_date', /(?:due\s+date|payment\s+due)\s*[:#-]?\s*([^\n,]{4,30})/i);
      add('subtotal', /subtotal\s*[:$ ]*([\d,]+(?:\.\d{1,2})?)/i);
      add('tax', /(?:tax|vat|gst)\s*[:$ ]*([\d,]+(?:\.\d{1,2})?)/i);
      add('total', /\b(?:grand\s+total|total|amount\s+due)\s*[:$ ]*\$?([\d,]+(?:\.\d{1,2})?)/i);
      add('currency', /\b(USD|EUR|GBP|CAD|AUD|JPY|INR)\b/i);
      if (!values.currency?.value && /\$\s*\d/.test(content)) values.currency = { value: 'USD', confidence: 0.72, source: 'symbol_inference' };
    } else if (documentType === 'BANK_STATEMENT') {
      add('account_holder', /(?:account holder|customer name|name)\s*[:#-]?\s*([^\n,]{2,100})/i);
      add('account_number', /(?:account number|account no\.?|acct\.?\s*#?)\s*[:#-]?\s*([Xx*\d -]{4,30})/i);
      add('bank_name', /(?:bank name|bank)\s*[:#-]?\s*([^\n,]{2,100})/i);
      add('statement_period_start', /(?:period start|from)\s*[:#-]?\s*([^\n,]{4,30})/i);
      add('statement_period_end', /(?:period end|through|to)\s*[:#-]?\s*([^\n,]{4,30})/i);
      add('opening_balance', /opening balance\s*[:$ ]*([\d,]+(?:\.\d{1,2})?)/i);
      add('closing_balance', /closing balance\s*[:$ ]*([\d,]+(?:\.\d{1,2})?)/i);
      add('currency', /\b(USD|EUR|GBP|CAD|AUD|JPY|INR)\b/i);
    } else if (documentType === 'KYC') {
      add('full_name', /(?:full name|name)\s*[:#-]?\s*([^\n,]{2,100})/i);
      add('date_of_birth', /(?:date of birth|birth date|dob)\s*[:#-]?\s*([^\n,]{4,30})/i);
      add('document_number', /(?:document number|document no\.?|passport no\.?|id number)\s*[:#-]?\s*([A-Z0-9 -]{4,30})/i);
      add('document_type', /(?:document type|identity document)\s*[:#-]?\s*([^\n,]{2,50})/i);
      add('expiry_date', /(?:expiry date|expires|expiration)\s*[:#-]?\s*([^\n,]{4,30})/i);
      add('address', /(?:address|residential address)\s*[:#-]?\s*([^\n]{5,160})/i);
    } else if (documentType === 'COMPLIANCE_REPORT') {
      add('report_name', /(?:report title|report name|title)\s*[:#-]?\s*([^\n,]{2,120})/i);
      if (!values.report_name?.value) addFirstLine('report_name', 0.58);
      add('reporting_period', /(?:reporting period|period)\s*[:#-]?\s*([^\n,]{3,50})/i);
      add('jurisdiction', /(?:jurisdiction|country)\s*[:#-]?\s*([^\n,]{2,80})/i);
      add('findings_count', /(?:findings|exceptions)\s*(?:count)?\s*[:#-]?\s*(\d+)/i);
      add('risk_rating', /(?:risk rating|risk level|overall risk)\s*[:#-]?\s*(low|medium|high|critical)/i);
      add('effective_date', /(?:effective date|as of|report date)\s*[:#-]?\s*([^\n,]{4,30})/i);
    }

    for (const field of DOCUMENT_SCHEMAS[documentType].fields) {
      values[field] ??= { value: null, confidence: 0, source: 'not_found' };
    }
    return values;
  }
}
