/**
 * Storage Service — S3 / Local Filesystem Abstraction
 *
 * When S3_BUCKET, S3_REGION, and AWS credentials are configured,
 * files are stored in S3. Otherwise falls back to local filesystem.
 *
 * This allows the same upload/download API regardless of where files live.
 */

import fs from 'fs';
import path from 'path';

const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'uploads');

// Ensure local upload dir exists
fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });

let s3Client: any = null;

async function getS3() {
    if (!S3_BUCKET) return null;
    if (s3Client) return s3Client;

    try {
        const { S3Client } = await import('@aws-sdk/client-s3');
        s3Client = new S3Client({ region: S3_REGION });
        return s3Client;
    } catch (e) {
        console.warn('[Storage] AWS SDK not available, using local storage');
        return null;
    }
}

export interface UploadResult {
    url: string;
    key: string;
    storage: 'local' | 's3';
}

/**
 * Upload a file to storage (S3 if configured, otherwise local).
 */
export async function uploadFile(
    filePath: string,
    key: string,
    contentType?: string,
): Promise<UploadResult> {
    const s3 = await getS3();

    if (s3 && S3_BUCKET) {
        try {
            const { PutObjectCommand } = await import('@aws-sdk/client-s3');
            const body = fs.readFileSync(filePath);

            await s3.send(
                new PutObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: key,
                    Body: body,
                    ContentType: contentType,
                }),
            );

            const url = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
            return { url, key, storage: 's3' };
        } catch (err) {
            console.error('[Storage] S3 upload failed, falling back to local:', err);
        }
    }

    // Local fallback
    const destDir = path.join(LOCAL_UPLOAD_DIR, path.dirname(key));
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(LOCAL_UPLOAD_DIR, key);
    fs.copyFileSync(filePath, destPath);

    return { url: `/uploads/${key}`, key, storage: 'local' };
}

/**
 * Generate a presigned URL for S3 (or return local path for local storage).
 */
export async function getPresignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const s3 = await getS3();

    if (s3 && S3_BUCKET) {
        try {
            const { GetObjectCommand } = await import('@aws-sdk/client-s3');
            const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

            const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
            return await getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
        } catch (err) {
            console.error('[Storage] Presigned URL failed:', err);
        }
    }

    // Local fallback
    return `/uploads/${key}`;
}

/**
 * Delete a file from storage.
 */
export async function deleteFile(key: string): Promise<boolean> {
    const s3 = await getS3();

    if (s3 && S3_BUCKET) {
        try {
            const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
            await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
            return true;
        } catch (err) {
            console.error('[Storage] S3 delete failed:', err);
        }
    }

    // Local fallback
    const filePath = path.join(LOCAL_UPLOAD_DIR, key);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
}

/**
 * Check if we're using S3 or local storage.
 */
export function getStorageMode(): 'local' | 's3' {
    return S3_BUCKET ? 's3' : 'local';
}
