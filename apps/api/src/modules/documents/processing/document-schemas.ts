import type { DocumentType } from '@prisma/client';

export type DocumentSchema = { required: string[]; fields: string[]; dates: string[]; numbers: string[] };

export const DOCUMENT_SCHEMAS: Record<DocumentType, DocumentSchema> = {
  INVOICE: {
    required: ['vendor_name', 'invoice_number', 'total', 'currency'],
    fields: ['vendor_name', 'invoice_number', 'invoice_date', 'due_date', 'subtotal', 'tax', 'total', 'currency'],
    dates: ['invoice_date', 'due_date'],
    numbers: ['subtotal', 'tax', 'total'],
  },
  BANK_STATEMENT: {
    required: ['account_holder', 'account_number', 'bank_name', 'closing_balance'],
    fields: ['account_holder', 'account_number', 'bank_name', 'statement_period_start', 'statement_period_end', 'opening_balance', 'closing_balance', 'currency'],
    dates: ['statement_period_start', 'statement_period_end'],
    numbers: ['opening_balance', 'closing_balance'],
  },
  KYC: {
    required: ['full_name', 'document_number', 'document_type', 'expiry_date'],
    fields: ['full_name', 'date_of_birth', 'document_number', 'document_type', 'expiry_date', 'address'],
    dates: ['date_of_birth', 'expiry_date'],
    numbers: [],
  },
  COMPLIANCE_REPORT: {
    required: ['report_name', 'risk_rating'],
    fields: ['report_name', 'reporting_period', 'jurisdiction', 'findings_count', 'risk_rating', 'effective_date'],
    dates: ['effective_date'],
    numbers: ['findings_count'],
  },
  UNKNOWN: { required: [], fields: [], dates: [], numbers: [] },
};
