import {
  PAPER2SLIDES_STAGE_ORDER,
  PAPER2SLIDES_STYLE_PRESETS,
} from '../../constants/workspace';

export type Paper2SlidesStage = (typeof PAPER2SLIDES_STAGE_ORDER)[number];
export type Paper2SlidesStylePreset = (typeof PAPER2SLIDES_STYLE_PRESETS)[number];

export type PresentationOptionsState = {
  output: 'slides' | 'poster';
  content: 'paper' | 'general';
  stylePreset: Paper2SlidesStylePreset;
  customStyle: string;
  length: 'short' | 'medium' | 'long';
  mode: 'fast' | 'normal';
  parallel: number;
  fromStage?: Paper2SlidesStage;
};
