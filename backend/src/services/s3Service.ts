import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { getBackendEnv } from '../config/env';

export class S3Service {
  private readonly client: S3Client;
  private readonly bucketName: string;
  private readonly publicBaseUrl: string;
  private readonly region: string;
  private readonly resolvedEndpoint: string;
  private readonly hasCustomEndpoint: boolean;
  private bucketReadyPromise: Promise<void> | null = null;

  constructor() {
    const s3 = getBackendEnv().s3;
    this.bucketName = s3.bucketName;
    this.publicBaseUrl = s3.publicBaseUrl;
    this.region = s3.region;
    this.resolvedEndpoint = s3.endpoint;
    this.hasCustomEndpoint = s3.hasCustomEndpoint;
    this.client = new S3Client({
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
      region: s3.region,
      endpoint: s3.endpoint,
      forcePathStyle: s3.forcePathStyle,
    });
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
      publicUrl: this.getPublicUrl(params.Key),
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

  getPublicUrl(key: string): string {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }
    if (this.hasCustomEndpoint) {
      const endpoint = new URL(this.resolvedEndpoint);
      const port = endpoint.port ? `:${endpoint.port}` : '';
      return `${endpoint.protocol}//${endpoint.hostname}${port}/${this.bucketName}/${key}`;
    }
    return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
  }
}
