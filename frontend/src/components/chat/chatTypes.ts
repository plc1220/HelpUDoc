import type { GoogleDrivePickerItem } from '../../types';

export type ChatComposerAttachment =
  | {
      id: string;
      name: string;
      source: 'local';
      file: File;
    }
  | {
      id: string;
      name: string;
      source: 'drive';
      driveItem: GoogleDrivePickerItem;
    };
