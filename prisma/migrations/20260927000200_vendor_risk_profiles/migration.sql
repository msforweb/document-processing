CREATE TABLE "VendorRiskProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "vendorKey" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "score" INTEGER NOT NULL DEFAULT 0,
    "documentCount" INTEGER NOT NULL DEFAULT 0,
    "highRiskCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateInvoiceCount" INTEGER NOT NULL DEFAULT 0,
    "averageInvoiceAmount" DOUBLE PRECISION,
    "signals" JSONB,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorRiskProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VendorRiskProfile_organizationId_vendorKey_key" ON "VendorRiskProfile"("organizationId", "vendorKey");
CREATE INDEX "VendorRiskProfile_organizationId_score_idx" ON "VendorRiskProfile"("organizationId", "score");
ALTER TABLE "VendorRiskProfile" ADD CONSTRAINT "VendorRiskProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
