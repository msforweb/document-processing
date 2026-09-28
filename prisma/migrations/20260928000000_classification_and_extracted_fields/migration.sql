ALTER TABLE "Document" ADD COLUMN "extractedText" TEXT;

CREATE TABLE "DocumentClassification" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "provider" TEXT NOT NULL,
    "rawOutput" JSONB,
    "classifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentClassification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DocumentClassification_documentId_key" ON "DocumentClassification"("documentId");
ALTER TABLE "DocumentClassification" ADD CONSTRAINT "DocumentClassification_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExtractedField" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "value" TEXT,
    "normalizedValue" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExtractedField_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExtractedField_documentId_fieldName_key" ON "ExtractedField"("documentId", "fieldName");
CREATE INDEX "ExtractedField_documentId_confidence_idx" ON "ExtractedField"("documentId", "confidence");
ALTER TABLE "ExtractedField" ADD CONSTRAINT "ExtractedField_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
