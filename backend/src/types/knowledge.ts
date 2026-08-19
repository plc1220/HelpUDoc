export type KnowledgeType = 'text' | 'table' | 'image' | 'presentation' | 'infographic';

/** Fixed id of the seeded catch-all knowledge base that every un-curated source belongs to. */
export const DEFAULT_KNOWLEDGE_BASE_ID = '00000000-0000-4000-8000-000000000010';

/** System user that owns the shared knowledge storage workspace; used to run KB uploads/ingestion on behalf of managers. */
export const KNOWLEDGE_STORAGE_USER_ID = '00000000-0000-4000-8000-000000000002';

export type KnowledgeBaseStatus = 'draft' | 'published' | 'archived';

export interface KnowledgeBase {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  ownerTeamId?: string | null;
  status: KnowledgeBaseStatus;
  currentVersion?: string | null;
  isDefault: boolean;
  createdByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseVersionMember {
  knowledgeSourceId: number;
  title: string;
  type: KnowledgeType;
  snapshotHash?: string | null;
}

export interface KnowledgeBaseVersion {
  id: string;
  knowledgeBaseId: string;
  version: string;
  memberSnapshot: KnowledgeBaseVersionMember[];
  note?: string | null;
  publishedByUserId?: string | null;
  publishedAt: string;
}

export interface KnowledgeSource {
  id: number;
  workspaceId: string;
  knowledgeBaseId?: string | null;
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
