import React from 'react';
import { List, ListItemButton, ListItemText, ListItemIcon } from '@mui/material';
import { Description, Image, Code, AttachMoney, Folder } from '@mui/icons-material';

import type { File } from '../types';

interface FileListProps {
  files: File[];
  onFileSelect: (file: File) => void;
}

const FileList: React.FC<FileListProps> = ({ files, onFileSelect }) => {
  const getFileIcon = (fileName: string) => {
    if (fileName.endsWith('.md')) {
      return <Description />;
    }
    if (fileName.endsWith('.html')) {
      return <Code />;
    }
    if (fileName.endsWith('.png')) {
      return <Image />;
    }
    if (fileName.includes('pricing')) {
      return <AttachMoney />;
    }
    // Basic folder detection
    if (!fileName.includes('.')) {
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