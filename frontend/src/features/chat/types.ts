import type { GcsBrowseEntry, GoogleDrivePickerItem } from '../../types';

export type ChatComposerAttachment =
  | {
      id: string;
      name: string;
      source: 'local';
      file: File;
      previewUrl?: string;
    }
  | {
      id: string;
      name: string;
      source: 'drive';
      driveItem: GoogleDrivePickerItem;
    }
  | {
      id: string;
      name: string;
      source: 'gcs';
      /** Object keys are only unique within a bucket, so the id travels too. */
      bucketId: string;
      gcsItem: GcsBrowseEntry;
    };
