-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "chunkCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "content" TEXT NOT NULL DEFAULT '';
