-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "currency" TEXT DEFAULT 'USD',
ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "extractedAt" TIMESTAMP(3),
ADD COLUMN     "invoiceDate" TIMESTAMP(3),
ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "totalAmount" DOUBLE PRECISION,
ADD COLUMN     "vendorName" TEXT;
