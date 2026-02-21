export const PAPER2SLIDES_STAGE_ORDER = ['rag', 'analysis', 'plan', 'generate'] as const;
export const PAPER2SLIDES_STYLE_PRESETS = ['academic', 'doraemon', 'custom'] as const;

export const SLASH_COMMANDS = [
  {
    id: 'presentation',
    command: '/presentation',
    description: 'Generate slides/posters from @files.',
  },
] as const;

export const SYSTEM_DIR_NAMES = new Set(['__macosx', 'skills']);
export const SYSTEM_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini']);

export const MIN_CANVAS_ZOOM = 0.6;
export const MAX_CANVAS_ZOOM = 2;
export const CANVAS_ZOOM_STEP = 0.1;
