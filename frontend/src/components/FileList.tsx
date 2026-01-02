import React from 'react';
import { List, ListItemButton, ListItemText, ListItemIcon } from '@mui/material';
import { Description, Image, Code, AttachMoney, Folder, PictureAsPdf } from '@mui/icons-material';

import type { File } from '../types';

interface FileListProps {
  files: File[];
  onFileSelect: (file: File) => void;
}

const FileList: React.FC<FileListProps> = ({ files, onFileSelect }) => {
  const getFileIcon = (fileName: string) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.md') || name.endsWith('.markdown')) {
      return <Description />;
    }
    if (name.endsWith('.html') || name.endsWith('.htm')) {
      return <Code />;
    }
    if (name.endsWith('.pdf')) {
      return <PictureAsPdf />;
    }
    if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].some((ext) => name.endsWith(ext))) {
      return <Image />;
    }
    if (name.includes('pricing')) {
      return <AttachMoney />;
    }
    // Basic folder detection
    if (!name.includes('.')) {
      return <Folder />;
    }
    return <Description />;
  };

  return (
    <List>
      {files.map((file) => (
        <ListItemButton key={file.id} onClick={() => onFileSelect(file)}>
          <ListItemIcon>{getFileIcon(file.name)}</ListItemIcon>
          <ListItemText primary={file.name} />
        </ListItemButton>
      ))}
    </List>
  );
};

export default FileList;
