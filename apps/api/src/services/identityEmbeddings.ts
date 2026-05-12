import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';

export type EmbeddingModality = 'FACE' | 'REID';

export interface IdentityEmbeddingPayload {
    modality: EmbeddingModality;
    model_name?: string;
    modelName?: string;
    dimension?: number;
    vector: number[];
    sample_path?: string | null;
    samplePath?: string | null;
}

export interface IdentityMatch {
    criminal_id: string;
    criminalId: string;
    criminal_name: string;
    name: string;
    fir_number: string | null;
    firNumber: string | null;
    mugshotUrl: string;
    confidence: number;
    method: 'face_embedding' | 'person_reid';
    identity_backend: string;
    modality: EmbeddingModality;
}

const DEFAULT_FACE_THRESHOLD = 0.65;
const DEFAULT_REID_THRESHOLD = 0.72;

const vectorLiteral = (vector: number[]): string | null => {
    if (!Array.isArray(vector) || vector.length === 0) return null;
    const clean = vector.map((value) => Number(value));
    if (clean.some((value) => !Number.isFinite(value))) return null;
    return `[${clean.join(',')}]`;
};

const normalizeEmbedding = (embedding: IdentityEmbeddingPayload): IdentityEmbeddingPayload | null => {
    const literal = vectorLiteral(embedding.vector);
    if (!literal) return null;
    const modality = String(embedding.modality || '').toUpperCase();
    if (modality !== 'FACE' && modality !== 'REID') return null;
    const modelName = String(embedding.model_name || embedding.modelName || '').trim();
    if (!modelName) return null;
    return {
        modality: modality as EmbeddingModality,
        model_name: modelName,
        dimension: Number(embedding.dimension || embedding.vector.length),
        vector: embedding.vector.map(Number),
        sample_path: embedding.sample_path ?? embedding.samplePath ?? null,
    };
};

export const storeIdentityEmbeddings = async (
    criminalId: string,
    embeddings: IdentityEmbeddingPayload[] | undefined,
    options: { replace?: boolean } = {},
): Promise<number> => {
    const normalized = (embeddings || [])
        .map(normalizeEmbedding)
        .filter((embedding): embedding is IdentityEmbeddingPayload => Boolean(embedding));

    if (options.replace !== false) {
        await prisma.$executeRaw`DELETE FROM "IdentityEmbedding" WHERE "criminalId" = ${criminalId}`;
    }

    let stored = 0;
    for (const embedding of normalized) {
        const literal = vectorLiteral(embedding.vector);
        if (!literal) continue;

        await prisma.$executeRaw(Prisma.sql`
            INSERT INTO "IdentityEmbedding" (
                "id",
                "criminalId",
                "modality",
                "modelName",
                "dimension",
                "vector",
                "samplePath"
            )
            VALUES (
                ${randomUUID()},
                ${criminalId},
                CAST(${embedding.modality} AS "EmbeddingModality"),
                ${embedding.model_name},
                ${embedding.dimension || embedding.vector.length},
                ${Prisma.raw(`'${literal}'::vector`)},
                ${embedding.sample_path || null}
            )
        `);
        stored += 1;
    }

    return stored;
};

type RawIdentityMatchRow = {
    criminalId: string;
    name: string;
    firNumber: string | null;
    mugshotUrl: string;
    modality: EmbeddingModality;
    modelName: string;
    similarity: number | string;
};

export const matchIdentityEmbeddings = async (
    embeddings: IdentityEmbeddingPayload[] | undefined,
    options: { faceThreshold?: number; reidThreshold?: number; limit?: number } = {},
): Promise<IdentityMatch[]> => {
    const normalized = (embeddings || [])
        .map(normalizeEmbedding)
        .filter((embedding): embedding is IdentityEmbeddingPayload => Boolean(embedding));

    const byCriminal = new Map<string, IdentityMatch>();
    const limit = Math.max(1, Math.min(Number(options.limit || 5), 20));

    for (const embedding of normalized) {
        const literal = vectorLiteral(embedding.vector);
        if (!literal) continue;

        const threshold = embedding.modality === 'REID'
            ? Number(options.reidThreshold ?? DEFAULT_REID_THRESHOLD)
            : Number(options.faceThreshold ?? DEFAULT_FACE_THRESHOLD);

        const rows = await prisma.$queryRaw<RawIdentityMatchRow[]>(Prisma.sql`
            SELECT
                e."criminalId" AS "criminalId",
                c."name" AS "name",
                c."firNumber" AS "firNumber",
                c."mugshotUrl" AS "mugshotUrl",
                e."modality"::text AS "modality",
                e."modelName" AS "modelName",
                1 - (e."vector" <=> ${Prisma.raw(`'${literal}'::vector`)}) AS "similarity"
            FROM "IdentityEmbedding" e
            JOIN "CriminalRecord" c ON c."id" = e."criminalId"
            WHERE e."modality" = CAST(${embedding.modality} AS "EmbeddingModality")
              AND e."modelName" = ${embedding.model_name}
              AND e."dimension" = ${embedding.dimension || embedding.vector.length}
            ORDER BY e."vector" <=> ${Prisma.raw(`'${literal}'::vector`)}
            LIMIT ${limit}
        `);

        for (const row of rows) {
            const confidence = Number(row.similarity);
            if (!Number.isFinite(confidence) || confidence < threshold) continue;

            const candidate: IdentityMatch = {
                criminal_id: row.criminalId,
                criminalId: row.criminalId,
                criminal_name: row.name,
                name: row.name,
                fir_number: row.firNumber,
                firNumber: row.firNumber,
                mugshotUrl: row.mugshotUrl,
                confidence,
                method: row.modality === 'REID' ? 'person_reid' : 'face_embedding',
                identity_backend: row.modelName,
                modality: row.modality,
            };

            const existing = byCriminal.get(row.criminalId);
            if (!existing || candidate.confidence > existing.confidence) {
                byCriminal.set(row.criminalId, candidate);
            }
        }
    }

    return Array.from(byCriminal.values()).sort((a, b) => b.confidence - a.confidence);
};

export const removeIdentityEmbeddings = async (criminalId: string): Promise<void> => {
    await prisma.$executeRaw`DELETE FROM "IdentityEmbedding" WHERE "criminalId" = ${criminalId}`;
};

export const stripIdentityEmbeddings = <T extends Record<string, any>>(value: T): T => {
    const clone = { ...value };
    delete clone.identity_embeddings;
    delete clone.identity_embedding;
    return clone;
};
