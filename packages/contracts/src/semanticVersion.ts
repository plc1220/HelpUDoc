/**
 * Governed skill versions are plain major.minor.patch, with no prerelease or build
 * metadata. An approved version is immutable, so ordering must be unambiguous.
 *
 * The submit form and the governance API both check against this, so a user sees
 * the same rule before submitting that the server enforces after.
 */
export const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A new governed skill has no history, so it always starts here. */
export const NEW_SKILL_SEMANTIC_VERSION = '1.0.0';

export const SEMANTIC_VERSION_FORMAT_HINT = 'Use major.minor.patch, for example 1.0.0.';

export const isSemanticVersion = (value: string): boolean =>
  SEMANTIC_VERSION_PATTERN.test(String(value || '').trim());

/**
 * Says why a proposed version cannot be submitted, or returns null.
 *
 * Covers only the rules that need no database. "Greater than every existing
 * version" for an improvement is still checked by the server.
 */
export const describeProposedVersionProblem = (
  value: string,
  proposalType: 'new' | 'improvement',
): string | null => {
  const version = String(value || '').trim();
  if (!version) {
    return `Enter a proposed version. ${SEMANTIC_VERSION_FORMAT_HINT}`;
  }
  if (!isSemanticVersion(version)) {
    return `"${version}" is not a valid version. ${SEMANTIC_VERSION_FORMAT_HINT}`;
  }
  if (proposalType === 'new' && version !== NEW_SKILL_SEMANTIC_VERSION) {
    return `A new skill must start at version ${NEW_SKILL_SEMANTIC_VERSION}.`;
  }
  return null;
};
