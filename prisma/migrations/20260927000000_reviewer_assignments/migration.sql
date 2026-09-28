CREATE TYPE "ReviewAssignmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'REASSIGNED');

ALTER TABLE "Document" ADD COLUMN "assignedReviewerId" TEXT;

CREATE TABLE "ReviewAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "assignedById" TEXT,
    "status" "ReviewAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ReviewAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Document_organizationId_assignedReviewerId_status_idx" ON "Document"("organizationId", "assignedReviewerId", "status");
CREATE INDEX "ReviewAssignment_organizationId_status_assignedAt_idx" ON "ReviewAssignment"("organizationId", "status", "assignedAt");
CREATE INDEX "ReviewAssignment_reviewerId_status_idx" ON "ReviewAssignment"("reviewerId", "status");
CREATE INDEX "ReviewAssignment_documentId_assignedAt_idx" ON "ReviewAssignment"("documentId", "assignedAt");

ALTER TABLE "Document" ADD CONSTRAINT "Document_assignedReviewerId_fkey" FOREIGN KEY ("assignedReviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
