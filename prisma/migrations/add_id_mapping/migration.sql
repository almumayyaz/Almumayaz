-- CreateTable
CREATE TABLE "IdMapping" (
    "id" TEXT NOT NULL,
    "legacyId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "newId" TEXT NOT NULL,
    "migratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IdMapping_newId_key" ON "IdMapping"("newId");

-- CreateIndex
CREATE INDEX "IdMapping_entityType_legacyId_idx" ON "IdMapping"("entityType", "legacyId");
