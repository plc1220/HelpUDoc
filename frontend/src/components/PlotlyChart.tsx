import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlotParams } from 'react-plotly.js';

export type PlotlySpec = Partial<PlotParams>;

type PlotlyRuntime = {
  react: (el: HTMLDivElement, figure: {
    data: PlotParams['data'];
    layout: PlotParams['layout'];
    config: PlotParams['config'];
    frames?: PlotParams['frames'];
  }) => Promise<unknown>;
  purge: (el: HTMLDivElement) => void;
};

interface PlotlyChartProps {
  spec: PlotlySpec;
  className?: string;
  minHeight?: number;
}

const PlotlyChart = ({ spec, className, minHeight = 320 }: PlotlyChartProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotlyRef = useRef<PlotlyRuntime | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const data = Array.isArray(spec?.data) ? spec.data : [];
  const layout = spec?.layout && typeof spec.layout === 'object' ? spec.layout : {};
  const config = spec?.config && typeof spec.config === 'object' ? spec.config : {};
  const frames = Array.isArray(spec?.frames) ? spec.frames : undefined;
  const figure = useMemo(
    () => ({
      data,
      layout: { autosize: true, ...layout },
      config: { displaylogo: false, responsive: true, ...config },
      frames,
    }),
    [config, data, frames, layout],
  );

  useEffect(() => {
    let cancelled = false;

    void import('plotly.js-dist-min')
      .then((module) => {
        if (cancelled) return;
        plotlyRef.current = module.default as unknown as PlotlyRuntime;
        setLoadError(null);
      })
      .catch((error) => {
        console.error('Failed to load Plotly', error);
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load chart renderer.');
        }
      });

    return () => {
      cancelled = true;
      if (plotlyRef.current && containerRef.current) {
        try {
          plotlyRef.current.purge(containerRef.current);
        } catch (error) {
          console.warn('Failed to purge Plotly chart', error);
        }
      }
    };
  }, []);

  useEffect(() => {
    const Plotly = plotlyRef.current;
    const el = containerRef.current;
    if (!Plotly || !el || loadError) {
      return;
    }

    let cancelled = false;
    void Plotly.react(el, figure).catch((error) => {
      console.error('Failed to render Plotly chart', error);
      if (!cancelled) {
        setLoadError(error instanceof Error ? error.message : 'Failed to render chart.');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [figure, loadError]);

  return (
    <div className={className ?? 'h-full w-full'} style={{ minHeight }}>
      {loadError ? (
        <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
          {loadError}
        </div>
      ) : (
        <div ref={containerRef} className="h-full w-full" />
      )}
    </div>
  );
};

export default PlotlyChart;
