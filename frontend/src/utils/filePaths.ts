/**
 * Path helpers with no runtime dependencies.
 *
 * Split out of `files.tsx` so modules that only need path handling do not pull in
 * that file's JSX and MUI icon imports — which also makes them reachable from the
 * `node --test` suite, where types are stripped but JSX is not transformed.
 * `files.tsx` re-exports this so existing importers are unaffected.
 */
export const normalizeFilePath = (value: string) => value.replace(/\\/g, '/');
