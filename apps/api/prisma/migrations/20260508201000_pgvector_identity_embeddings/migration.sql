-- Store face and person-ReID identity vectors in Postgres.
-- Requires the pgvector extension to be available in the database image.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "EmbeddingModality" AS ENUM ('FACE', 'REID');

CREATE TABLE "IdentityEmbedding" (
    "id" TEXT NOT NULL,
    "criminalId" TEXT NOT NULL,
    "modality" "EmbeddingModality" NOT NULL,
    "modelName" TEXT NOT NULL,
    "dimension" INTEGER NOT NULL,
    "vector" vector NOT NULL,
    "samplePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IdentityEmbedding_criminalId_idx" ON "IdentityEmbedding"("criminalId");
CREATE INDEX "IdentityEmbedding_modality_modelName_dimension_idx" ON "IdentityEmbedding"("modality", "modelName", "dimension");

ALTER TABLE "IdentityEmbedding"
    ADD CONSTRAINT "IdentityEmbedding_criminalId_fkey"
    FOREIGN KEY ("criminalId") REFERENCES "CriminalRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
