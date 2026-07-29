export type PublicationFileState = {
  hash: string;
};

export type PublicationConflict = {
  path: string;
  privateChange: 'added' | 'changed' | 'deleted';
  teamChange: 'added' | 'changed' | 'deleted';
};

const changeKind = (
  base: PublicationFileState | undefined,
  next: PublicationFileState | undefined,
): PublicationConflict['privateChange'] => {
  if (!base && next) return 'added';
  if (base && !next) return 'deleted';
  return 'changed';
};

export const hasFileChanged = (
  base: PublicationFileState | undefined,
  next: PublicationFileState | undefined,
): boolean => (base?.hash || null) !== (next?.hash || null);

export const findPublicationConflicts = (
  base: Map<string, PublicationFileState>,
  privateFiles: Map<string, PublicationFileState>,
  teamFiles: Map<string, PublicationFileState>,
): PublicationConflict[] => {
  const paths = new Set([...base.keys(), ...privateFiles.keys(), ...teamFiles.keys()]);
  const conflicts: PublicationConflict[] = [];

  for (const filePath of paths) {
    const baseFile = base.get(filePath);
    const privateFile = privateFiles.get(filePath);
    const teamFile = teamFiles.get(filePath);
    const privateChanged = hasFileChanged(baseFile, privateFile);
    const teamChanged = hasFileChanged(baseFile, teamFile);
    const versionsDiffer = hasFileChanged(privateFile, teamFile);

    if (privateChanged && teamChanged && versionsDiffer) {
      conflicts.push({
        path: filePath,
        privateChange: changeKind(baseFile, privateFile),
        teamChange: changeKind(baseFile, teamFile),
      });
    }
  }

  return conflicts.sort((left, right) => left.path.localeCompare(right.path));
};

export const mergePublicationFolders = (
  baseFolders: Iterable<string>,
  privateFolders: Iterable<string>,
  teamFolders: Iterable<string>,
  selectedFilePaths: Iterable<string> = [],
): string[] => {
  const base = new Set(baseFolders);
  const privateSet = new Set(privateFolders);
  const team = new Set(teamFolders);
  const paths = new Set([...base, ...privateSet, ...team]);
  const merged = new Set<string>();

  for (const folderPath of paths) {
    const baseHasFolder = base.has(folderPath);
    const privateHasFolder = privateSet.has(folderPath);
    const teamHasFolder = team.has(folderPath);
    const privateChanged = privateHasFolder !== baseHasFolder;
    const teamChanged = teamHasFolder !== baseHasFolder;
    const selected = privateChanged
      ? privateHasFolder
      : teamChanged
        ? teamHasFolder
        : privateHasFolder;
    if (selected) merged.add(folderPath);
  }

  for (const filePath of selectedFilePaths) {
    const parts = filePath.split('/').filter(Boolean);
    parts.pop();
    for (let index = 1; index <= parts.length; index += 1) {
      merged.add(parts.slice(0, index).join('/'));
    }
  }

  return [...merged].sort((left, right) => left.localeCompare(right));
};
