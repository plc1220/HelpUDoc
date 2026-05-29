export const SLASH_COMMANDS = [
  {
    id: 'skill',
    command: '/skill',
    description: 'Load and follow a specific skill, e.g. /skill sales',
  },
  {
    id: 'mcp',
    command: '/mcp',
    description: 'Prefer tools from a specific MCP server, e.g. /mcp google-workspace',
  },
] as const;

export const SYSTEM_DIR_NAMES = new Set(['__macosx', 'skills', 'charts', 'data_cache']);
export const SYSTEM_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini']);

export const MIN_CANVAS_ZOOM = 0.6;
export const MAX_CANVAS_ZOOM = 2;
export const CANVAS_ZOOM_STEP = 0.1;
