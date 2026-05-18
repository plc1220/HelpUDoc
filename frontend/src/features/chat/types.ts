import type { GoogleDrivePickerItem } from '../../types';

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
    };
