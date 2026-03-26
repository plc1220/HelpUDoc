import type { PlotlySpec } from '../components/PlotlyChart';

const PLOTLY_FENCE_PATTERN = /^```(?:json|plotly)?\s*([\s\S]*?)\s*```$/i;

export const normalizePlotlySpecSource = (value: string): string => {
  const trimmed = value.replace(/^\uFEFF/, '').trim();
  const fenced = trimmed.match(PLOTLY_FENCE_PATTERN);
  return fenced ? fenced[1].trim() : trimmed;
};

export const parsePlotlySpec = (value: string): PlotlySpec | null => {
  const normalized = normalizePlotlySpecSource(value);
  if (!normalized) {
    return null;
  }

  const spec = JSON.parse(normalized) as PlotlySpec;
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.data)) {
    throw new Error('Plotly spec must include a top-level "data" array.');
  }

  return spec;
};
