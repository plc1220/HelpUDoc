/**
 * Render the teams that can reach a workspace.
 *
 * A workspace can be shared with any number of teams, so the raw list would
 * overflow a sidebar row or a table cell. Name the first, count the rest, and
 * leave the full list to a `title` attribute.
 */
export const formatTeamNames = (names: string[], limit = 2): string => {
  if (!names.length) return '';
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} +${names.length - limit}`;
};
