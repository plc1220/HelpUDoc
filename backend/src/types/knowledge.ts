export type KnowledgeType = 'text' | 'table' | 'image' | 'presentation' | 'infographic';

export interface KnowledgeSource {
  id: number;
  workspaceId: string;
  title: string;
  type: KnowledgeType;
  description?: string | null;
  content?: string | null;
  fileId?: number | null;
  sourceUrl?: string | null;
  tags?: any;
  metadata?: Record<string, any> | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  file?: {
    id: number;
    name: string;
    mimeType?: string | null;
    publicUrl?: string | null;
    storageType?: string | null;
    path?: string | null;
  } | null;
}
