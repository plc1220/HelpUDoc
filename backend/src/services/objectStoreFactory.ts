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

let publicationSingleton: ObjectStore | null = null;

/**
 * Store for published file artifacts.
 *
 * Kept separate from the workspace store so published documents survive the
 * deletion of the workspace that produced them, and so the bucket holding them
 * can carry its own retention policy.
 */
export function createPublicationObjectStore(): ObjectStore {
  const config = getBackendEnv().objectStore.publication;
  if (config.provider === 'gcs') {
    return new GcsObjectStore({
      bucketName: config.bucketName,
      projectId: config.gcs.projectId,
      keyFilename: config.gcs.keyFilename,
      apiEndpoint: config.gcs.apiEndpoint,
    });
  }
  // S3Service takes a whole config; reuse the primary credentials and
  // endpoint, overriding only the bucket.
  return new S3Service({
    config: { ...getBackendEnv().s3, bucketName: config.bucketName },
  });
}

export function getPublicationObjectStore(): ObjectStore {
  if (!publicationSingleton) {
    publicationSingleton = createPublicationObjectStore();
  }
  return publicationSingleton;
}

/**
 * Logged once at boot so a misconfigured deployment is visible immediately
 * rather than at the first publish.
 */
export function describePublicationTarget(): string {
  const config = getBackendEnv().objectStore.publication;
  const location = `${config.provider}://${config.bucketName}`
    + (config.prefix ? `/${config.prefix}` : '');
  return config.usingPrimaryStore
    ? `${location} (no PUBLICATION_BUCKET_NAME set — sharing the workspace store)`
    : location;
}

export function resetObjectStoreForTests(): void {
  singleton = null;
  publicationSingleton = null;
}
