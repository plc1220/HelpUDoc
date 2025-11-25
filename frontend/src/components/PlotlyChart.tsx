import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import type { PlotParams } from 'react-plotly.js';
import React from 'react';

const Plot = createPlotlyComponent(Plotly);

export type PlotlySpec = Partial<PlotParams>;

interface PlotlyChartProps {
  spec: PlotlySpec;
  className?: string;
  minHeight?: number;
}

const PlotlyChart: React.FC<PlotlyChartProps> = ({ spec, className, minHeight = 320 }) => {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  const layout = spec?.layout && typeof spec.layout === 'object' ? spec.layout : {};
  const config = spec?.config && typeof spec.config === 'object' ? spec.config : {};
  const frames = Array.isArray(spec?.frames) ? spec.frames : undefined;

  return (
    <div className={className ?? 'h-full w-full'} style={{ minHeight }}>
      <Plot
        data={data}
        layout={{ autosize: true, ...layout }}
        config={{ displaylogo: false, responsive: true, ...config }}
        frames={frames}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  );
};

export default PlotlyChart;
