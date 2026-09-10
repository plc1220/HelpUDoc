import type { Knex } from 'knex';
import { promises as fs } from 'fs';
import path from 'path';
import { skillsRoot } from '../skills/constants';
import { sha256 } from './skillGovernanceModel';

export const executionBlockPath = (id: string) => path.join(skillsRoot, '.governed-blocks', id);
export const skillBlockId = (skillKey: string) => sha256(`skill:${skillKey}`);
export const versionBlockId = (manifestHash: string) => sha256(`package:${manifestHash}`);

export async function filterExecutablePins<T extends { skillKey: string; manifestHash: string }>(db: Knex, pins: T[]): Promise<T[]> {
  const blocks = await db('skill_execution_blocks').select('skillKey', 'manifestHash');
  return pins.filter(pin => !blocks.some((block: any) => block.manifestHash
    ? block.manifestHash === pin.manifestHash : block.skillKey === pin.skillKey));
}

export async function writeExecutionBlock(id: string, reason: string): Promise<void> {
  await fs.mkdir(path.dirname(executionBlockPath(id)), { recursive: true });
  await fs.writeFile(executionBlockPath(id), reason, { mode: 0o644 });
}
