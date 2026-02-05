export type Paper2SlidesOutputType = 'slides' | 'poster';
export type Paper2SlidesContentType = 'paper' | 'general';
export type Paper2SlidesMode = 'fast' | 'normal';
export type Paper2SlidesStage = 'rag' | 'summary' | 'plan' | 'generate' | 'analysis';
export type Paper2SlidesLength = 'short' | 'medium' | 'long';

export type Paper2SlidesOptions = {
  output?: Paper2SlidesOutputType;
  content?: Paper2SlidesContentType;
  style?: string;
  length?: Paper2SlidesLength;
  mode?: Paper2SlidesMode;
  parallel?: number | boolean;
  fromStage?: Paper2SlidesStage;
  exportPptx?: boolean;
};
