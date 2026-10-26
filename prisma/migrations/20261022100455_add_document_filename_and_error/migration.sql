-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "error" TEXT,
ADD COLUMN     "filename" TEXT NOT NULL DEFAULT 'document.txt';
