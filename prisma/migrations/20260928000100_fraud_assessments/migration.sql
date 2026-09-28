CREATE TABLE "FraudAssessment" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "signals" JSONB,
    "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FraudAssessment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FraudAssessment_documentId_key" ON "FraudAssessment"("documentId");
CREATE INDEX "FraudAssessment_score_assessedAt_idx" ON "FraudAssessment"("score", "assessedAt");
ALTER TABLE "FraudAssessment" ADD CONSTRAINT "FraudAssessment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
