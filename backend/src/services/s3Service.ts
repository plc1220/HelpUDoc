import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'default-bucket-name';

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
  region: process.env.AWS_REGION,
});

export class S3Service {
  async uploadFile(
    workspaceName: string,
    fileName: string,
    fileStream: Buffer,
  ) {
    const params = {
      Bucket: S3_BUCKET_NAME,
      Key: `${workspaceName}/${fileName}`,
      Body: fileStream,
    };

    const command = new PutObjectCommand(params);
    const result = await s3.send(command);
    
    // The v3 response is different. We'll return a simplified object
    // that includes the necessary details for the file service.
    return {
      ...result,
      Key: params.Key,
      Bucket: params.Bucket,
    };
  }
}