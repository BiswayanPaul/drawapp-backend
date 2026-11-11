-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "accessVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "passwordHash" TEXT;
