import React from 'react';
import { List, ListItemButton, ListItemText, ListItemIcon } from '@mui/material';

import type { File } from '../types';
import { getFileTypeIcon } from '../utils/files';

interface FileListProps {
  files: File[];
  onFileSelect: (file: File) => void;
}

const FileList: React.FC<FileListProps> = ({ files, onFileSelect }) => {
  return (
    <List>
      {files.map((file) => (
        <ListItemButton key={file.id} onClick={() => onFileSelect(file)}>
          <ListItemIcon>{getFileTypeIcon(file.name)}</ListItemIcon>
          <ListItemText primary={file.name} />
        </ListItemButton>
      ))}
    </List>
  );
};

export default FileList;
