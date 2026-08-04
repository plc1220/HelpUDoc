import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getBackendEnv } from '../config/env';

export class S3Service {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucketName: string;
  private bucketReadyPromise: Promise<void> | null = null;

  constructor() {
    const s3 = getBackendEnv().s3;
    this.bucketName = s3.bucketName;
    const clientOptions = {
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
      region: s3.region,
      forcePathStyle: s3.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({ ...clientOptions, endpoint: s3.endpoint });
    this.publicClient = new S3Client({ ...clientOptions, endpoint: s3.publicEndpoint });
  }

  private async ensureBucketExists(): Promise<void> {
    if (!this.bucketReadyPromise) {
      this.bucketReadyPromise = (async () => {
        try {
          await this.client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
        } catch (error: any) {
          const code = String(error?.Code || error?.name || '');
          const status = Number(error?.$metadata?.httpStatusCode || 0);
          const shouldCreate = code === 'NotFound' || code === 'NoSuchBucket' || status === 404;
          if (!shouldCreate) {
            throw error;
          }
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucketName }));
        }
      })().catch((error) => {
        this.bucketReadyPromise = null;
        throw error;
      });
    }
    await this.bucketReadyPromise;
  }

  async uploadFile(
    workspaceName: string,
    fileName: string,
    fileStream: Buffer,
    mimeType?: string,
    keyOverride?: string,
  ) {
    await this.ensureBucketExists();
    const key = keyOverride || `${workspaceName}/${fileName.replace(/\\/g, '/')}`;
    const params = {
      Bucket: this.bucketName,
      Key: key,
      Body: fileStream,
      ContentType: mimeType,
    };

    const command = new PutObjectCommand(params);
    const result = await this.client.send(command);

    return {
      ...result,
      Key: params.Key,
      Bucket: params.Bucket,
    };
  }

  async getFile(key: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    const response = await this.client.send(command);
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

  async createPresignedUploadUrl(
    key: string,
    mimeType: string,
    expiresInSeconds: number,
  ): Promise<string> {
    await this.ensureBucketExists();
    return getSignedUrl(
      this.publicClient,
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: mimeType,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async headFile(key: string): Promise<{
    sizeBytes: number;
    mimeType: string | null;
    etag: string | null;
  }> {
    const response = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    }));
    return {
      sizeBytes: Number(response.ContentLength || 0),
      mimeType: response.ContentType || null,
      etag: response.ETag?.replace(/^"|"$/g, '') || null,
    };
  }

  async downloadFileToPath(key: string, destinationPath: string): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    }));
    if (!response.Body) {
      throw new Error(`Failed to read S3 object: ${key}`);
    }
    await pipeline(response.Body as Readable, createWriteStream(destinationPath));
  }

  async deleteFile(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    await this.client.send(command);
  }

  async copyFile(oldKey: string, newKey: string): Promise<void> {
    await this.ensureBucketExists();
    const encodedSource = encodeURIComponent(oldKey).replace(/%2F/g, '/');
    const command = new CopyObjectCommand({
      Bucket: this.bucketName,
      CopySource: `/${this.bucketName}/${encodedSource}`,
      Key: newKey,
    });
    await this.client.send(command);
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const listResponse = await this.client.send(listCommand);
      const keys = (listResponse.Contents || [])
        .map((item) => item.Key)
        .filter((k): k is string => Boolean(k));

      if (keys.length > 0) {
        const deleteCommand = new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: {
            Objects: keys.map((k) => ({ Key: k })),
            Quiet: true,
          },
        });
        await this.client.send(deleteCommand);
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
    } while (continuationToken);
  }

}
