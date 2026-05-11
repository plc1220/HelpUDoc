import path from 'path';
import { existsSync } from 'fs';

/** Repository root (parent of `backend/`) */
export const repoRoot = path.resolve(__dirname, '../../../..');

export const skillsRoot = process.env.SKILLS_ROOT || path.join(repoRoot, 'skills');
