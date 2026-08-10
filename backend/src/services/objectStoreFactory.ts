import { getBackendEnv } from '../config/env';
import { GcsObjectStore } from './gcsObjectStore';
import type { ObjectStore } from './objectStore';
import { S3Service } from './s3Service';

let singleton: ObjectStore | null = null;

export function createObjectStore(): ObjectStore {
  const config = getBackendEnv().objectStore;
  if (config.provider === 'gcs') {
    return new GcsObjectStore({
      bucketName: config.gcs.bucketName,
      projectId: config.gcs.projectId,
      keyFilename: config.gcs.keyFilename,
      apiEndpoint: config.gcs.apiEndpoint,
    });
  }
  return new S3Service();
}

export function getObjectStore(): ObjectStore {
  if (!singleton) {
    singleton = createObjectStore();
  }
  return singleton;
}

export function resetObjectStoreForTests(): void {
  singleton = null;
}
