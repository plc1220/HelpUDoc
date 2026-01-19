import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'helpudoc';
const RESOLVED_ENDPOINT = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || 'http://localhost:9000';
const HAS_CUSTOM_ENDPOINT = Boolean(process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT);
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE === 'true' || (!process.env.S3_FORCE_PATH_STYLE && HAS_CUSTOM_ENDPOINT);
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID || process.env.MINIO_ROOT_USER || 'minioadmin';
const S3_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.MINIO_ROOT_PASSWORD || 'minioadmin';
const S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL
  || `${RESOLVED_ENDPOINT.replace(/\/$/, '')}/${S3_BUCKET_NAME}`;

const s3 = new S3Client({
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  },
  region: S3_REGION,
  endpoint: RESOLVED_ENDPOINT,
  forcePathStyle: S3_FORCE_PATH_STYLE,
});

export class S3Service {
  async uploadFile(
    workspaceName: string,
    fileName: string,
    fileStream: Buffer,
    mimeType?: string,
    keyOverride?: string,
  ) {
    const key = keyOverride || `${workspaceName}/${fileName.replace(/\\/g, '/')}`;
    const params = {
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Body: fileStream,
      ContentType: mimeType,
    };

    const command = new PutObjectCommand(params);
    const result = await s3.send(command);
    
    // The v3 response is different. We'll return a simplified object
    // that includes the necessary details for the file service.
    return {
      ...result,
      Key: params.Key,
      Bucket: params.Bucket,
      publicUrl: this.getPublicUrl(params.Key),
    };
  }

  async getFile(key: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });
    const response = await s3.send(command);
    if (!response.Body) {
      throw new Error(`Failed to read S3 object: ${key}`);
    }
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Buffer));
    }
    return Buffer.concat(chunks);
  }

  async deleteFile(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });
    await s3.send(command);
  }

  async copyFile(oldKey: string, newKey: string): Promise<void> {
    const encodedSource = encodeURIComponent(oldKey).replace(/%2F/g, '/');
    const command = new CopyObjectCommand({
      Bucket: S3_BUCKET_NAME,
      CopySource: `/${S3_BUCKET_NAME}/${encodedSource}`,
      Key: newKey,
    });
    await s3.send(command);
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: S3_BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const listResponse = await s3.send(listCommand);
      const keys = (listResponse.Contents || [])
        .map((item) => item.Key)
        .filter((key): key is string => Boolean(key));

      if (keys.length > 0) {
        const deleteCommand = new DeleteObjectsCommand({
          Bucket: S3_BUCKET_NAME,
          Delete: {
            Objects: keys.map((key) => ({ Key: key })),
            Quiet: true,
          },
        });
        await s3.send(deleteCommand);
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  getPublicUrl(key: string): string {
    if (S3_PUBLIC_BASE_URL) {
      return `${S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
    }
    if (HAS_CUSTOM_ENDPOINT) {
      const endpoint = new URL(RESOLVED_ENDPOINT);
      const port = endpoint.port ? `:${endpoint.port}` : '';
      return `${endpoint.protocol}//${endpoint.hostname}${port}/${S3_BUCKET_NAME}/${key}`;
    }
    return `https://${S3_BUCKET_NAME}.s3.${S3_REGION}.amazonaws.com/${key}`;
  }
}
