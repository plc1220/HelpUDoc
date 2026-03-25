from __future__ import annotations

import html
import json
from typing import Any, Dict, List, Optional


PLOTLY_CDN = "https://cdn.plot.ly/plotly-3.3.0.min.js"

SUMMARY_CSS = """
    :root {
      --bg: #f3ede2;
      --panel: rgba(255, 251, 245, 0.94);
      --panel-strong: #fffdf8;
      --ink: #24313f;
      --muted: #667085;
      --line: rgba(143, 119, 91, 0.18);
      --accent: #0f5c4d;
      --accent-soft: rgba(15, 92, 77, 0.12);
      --warm: #c9792b;
      --shadow: 0 22px 60px rgba(71, 51, 25, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(201, 121, 43, 0.16), transparent 28%),
        radial-gradient(circle at top right, rgba(15, 92, 77, 0.14), transparent 26%),
        linear-gradient(180deg, #f9f5ef 0%, var(--bg) 100%);
      font-family: "Avenir Next", "Segoe UI", sans-serif;
    }
    .shell { max-width: 1140px; margin: 0 auto; padding: 28px 20px 56px; }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
    }
    .hero {
      padding: 32px;
      position: relative;
      overflow: hidden;
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -40px -60px auto;
      width: 220px;
      height: 220px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(201, 121, 43, 0.22), transparent 70%);
      pointer-events: none;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.72);
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .hero h1 {
      margin: 16px 0 10px;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: clamp(2.2rem, 5vw, 4rem);
      line-height: 0.98;
      letter-spacing: -0.04em;
    }
    .hero p {
      max-width: 760px;
      margin: 0;
      color: #455467;
      font-size: 1rem;
      line-height: 1.7;
    }
    .hero-meta {
      margin-top: 18px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .metric-section { margin-top: 22px; }
    .metric-heading {
      margin: 0 0 12px;
      font-size: 0.86rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
    }
    .metric-card {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(255, 250, 244, 0.95));
      border: 1px solid rgba(143, 119, 91, 0.14);
      border-radius: 20px;
      padding: 18px;
      min-height: 132px;
    }
    .metric-label {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .metric-value {
      margin-top: 10px;
      font-size: clamp(1.8rem, 3vw, 2.5rem);
      font-weight: 700;
      line-height: 1;
    }
    .metric-meta {
      margin-top: 10px;
      color: #516172;
      font-size: 0.92rem;
      line-height: 1.5;
    }
    .panel { margin-top: 22px; padding: 28px 30px; }
    .panel h2 {
      margin: 0 0 14px;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: 1.7rem;
      letter-spacing: -0.03em;
    }
    .panel h3 { margin: 0 0 10px; font-size: 1.08rem; }
    .panel h4 { margin: 18px 0 8px; font-size: 0.96rem; color: var(--muted); }
    .panel p, .agent-markdown { line-height: 1.7; }
    .agent-markdown code, .panel code {
      background: rgba(15, 92, 77, 0.08);
      border-radius: 8px;
      padding: 0.16rem 0.42rem;
      font-size: 0.92em;
    }
    .stack { display: grid; gap: 16px; }
    .stack-item {
      background: var(--panel-strong);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
    }
    .stack-meta {
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 0.88rem;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      overflow: hidden;
      border-radius: 16px;
      border: 1px solid var(--line);
      background: #fff;
    }
    table thead { background: rgba(15, 92, 77, 0.08); }
    table th, table td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(143, 119, 91, 0.12);
      text-align: left;
      font-size: 0.95rem;
    }
    table tr:last-child td { border-bottom: 0; }
    pre {
      margin: 0;
      background: #17212b;
      color: #e9eff5;
      padding: 14px 16px;
      border-radius: 16px;
      overflow-x: auto;
      white-space: pre-wrap;
    }
    img {
      max-width: 100%;
      display: block;
      border-radius: 18px;
      border: 1px solid var(--line);
    }
    .plotly-embed { width: 100%; min-height: 420px; }
    .split-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 18px;
    }
    @media (max-width: 768px) {
      .shell { padding: 16px 14px 40px; }
      .hero, .panel { padding: 22px 18px; border-radius: 22px; }
      .plotly-embed { min-height: 320px; }
    }
"""

SUMMARY_SUBTITLE = (
    "A polished, self-contained analysis artifact that combines narrative findings, "
    "SQL evidence, and the visual outputs created during this run."
)

DASHBOARD_CSS = """
    :root {
      --bg: #f3ede2;
      --panel: rgba(255, 251, 245, 0.94);
      --panel-strong: #fffdf8;
      --ink: #24313f;
      --muted: #667085;
      --line: rgba(143, 119, 91, 0.18);
      --accent: #0f5c4d;
      --accent-soft: rgba(15, 92, 77, 0.1);
      --warm: #c9792b;
      --shadow: 0 22px 60px rgba(71, 51, 25, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(201, 121, 43, 0.16), transparent 28%),
        radial-gradient(circle at top right, rgba(15, 92, 77, 0.14), transparent 26%),
        linear-gradient(180deg, #f9f5ef 0%, var(--bg) 100%);
      font-family: "Avenir Next", "Segoe UI", sans-serif;
    }
    .shell { max-width: 1340px; margin: 0 auto; padding: 28px 20px 56px; }
    .hero, .section, .filter-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
    }
    .hero { padding: 32px; position: relative; overflow: hidden; }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -40px -60px auto;
      width: 240px;
      height: 240px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(15, 92, 77, 0.18), transparent 70%);
      pointer-events: none;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.72);
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .hero h1 {
      margin: 16px 0 10px;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: clamp(2.4rem, 5vw, 4.3rem);
      line-height: 0.96;
      letter-spacing: -0.05em;
    }
    .hero p {
      max-width: 760px;
      margin: 0;
      color: #455467;
      font-size: 1rem;
      line-height: 1.72;
    }
    .hero-meta { margin-top: 18px; color: var(--muted); font-size: 0.92rem; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-top: 22px;
    }
    .metric-card {
      background: linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255, 250, 244, 0.96));
      border: 1px solid rgba(143, 119, 91, 0.14);
      border-radius: 20px;
      padding: 18px;
      min-height: 132px;
    }
    .metric-label {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .metric-value {
      margin-top: 10px;
      font-size: clamp(1.8rem, 3vw, 2.5rem);
      font-weight: 700;
      line-height: 1;
    }
    .metric-meta {
      margin-top: 10px;
      color: #516172;
      font-size: 0.92rem;
      line-height: 1.5;
    }
    .section, .filter-card { margin-top: 22px; padding: 28px 30px; }
    .section h2, .filter-card h2 {
      margin: 0 0 12px;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: 1.75rem;
      letter-spacing: -0.03em;
    }
    .chart-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
    }
    .chart-card {
      background: linear-gradient(180deg, #fffefb 0%, #fbf8f2 100%);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 18px;
      min-height: 100%;
    }
    .chart-card.filter-aware { grid-column: span 1; }
    .chart-card h3 { margin: 0 0 8px; font-size: 1.08rem; }
    .chart-meta {
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 0.88rem;
    }
    .chart-note {
      margin: 10px 0 0;
      color: #516172;
      font-size: 0.92rem;
      line-height: 1.5;
    }
    .plotly-embed { width: 100%; height: 340px; }
    img.chart-img {
      width: 100%;
      border-radius: 16px;
      border: 1px solid var(--line);
    }
    .filter-controls {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .filter-control { display: flex; flex-direction: column; gap: 6px; }
    .filter-control label {
      font-size: 0.88rem;
      font-weight: 700;
      color: #374151;
    }
    .filter-control select,
    .filter-control input,
    .filter-actions button {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    .filter-actions {
      display: flex;
      gap: 10px;
      align-items: end;
      margin-top: 14px;
    }
    .filter-actions button {
      cursor: pointer;
      background: var(--accent);
      color: #fff;
      font-weight: 700;
    }
    .filter-actions button.secondary {
      background: #fff;
      color: var(--ink);
    }
    .dataset-meta { margin-top: 14px; color: var(--muted); font-size: 0.86rem; }
    details.appendix { margin-top: 18px; }
    summary {
      cursor: pointer;
      color: var(--accent);
      font-weight: 700;
      list-style: none;
    }
    summary::-webkit-details-marker { display: none; }
    .query-item {
      background: #faf7f1;
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      margin-top: 12px;
    }
    .query-meta {
      font-size: 0.82rem;
      color: var(--warm);
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .query-block {
      margin: 0;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px 16px;
      overflow-x: auto;
      white-space: pre-wrap;
      color: #374151;
    }
    @media (max-width: 768px) {
      .shell { padding: 16px 14px 40px; }
      .hero, .section, .filter-card { padding: 22px 18px; border-radius: 22px; }
      .chart-grid { grid-template-columns: 1fr; }
      .plotly-embed { height: 300px; }
    }
"""

DASHBOARD_FILTER_SCRIPT = """
    (function() {
      if (!DASHBOARD_DATASET.length || !DASHBOARD_FILTER_SCHEMA.length || !DASHBOARD_CHART_DEFS.length) {
        return;
      }

      const controlHost = document.getElementById('dashboard-filter-controls');
      const applyButton = document.getElementById('dashboard-apply-filters');
      const resetButton = document.getElementById('dashboard-reset-filters');
      const fieldTypes = Object.fromEntries((DASHBOARD_DATASET_SCHEMA || []).map((item) => [item.name, String(item.type || '').toLowerCase()]));

      function inferFieldType(filterDef) {
        if (filterDef.type === 'numeric' || filterDef.type === 'date' || filterDef.type === 'datetime') {
          return filterDef.type;
        }
        const raw = fieldTypes[filterDef.field] || '';
        if (raw.includes('date') || raw.includes('time')) return 'date';
        if (raw.includes('int') || raw.includes('float') || raw.includes('double') || raw.includes('decimal')) return 'numeric';
        return 'categorical';
      }

      function parseDateValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }

      function parseNumericValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      }

      function normalizeComparable(value, type) {
        if (type === 'date' || type === 'datetime') {
          const parsed = parseDateValue(value);
          return parsed ? parsed.getTime() : null;
        }
        if (type === 'numeric') {
          return parseNumericValue(value);
        }
        return value;
      }

      function distinctValues(field) {
        const values = [];
        const seen = new Set();
        DASHBOARD_DATASET.forEach((row) => {
          const value = row[field];
          const key = value === null || value === undefined ? '__null__' : String(value);
          if (!seen.has(key) && value !== null && value !== undefined && value !== '') {
            seen.add(key);
            values.push(value);
          }
        });
        return values.sort((a, b) => String(a).localeCompare(String(b)));
      }

      function fieldExtent(field, type) {
        let min = null;
        let max = null;
        DASHBOARD_DATASET.forEach((row) => {
          const value = normalizeComparable(row[field], type);
          if (value === null) return;
          if (min === null || value < min) min = value;
          if (max === null || value > max) max = value;
        });
        return { min, max };
      }

      function createControl(filterDef) {
        const wrapper = document.createElement('div');
        wrapper.className = 'filter-control';
        const label = document.createElement('label');
        label.textContent = filterDef.label;
        wrapper.appendChild(label);
        const fieldType = inferFieldType(filterDef);
        filterDef.resolvedType = fieldType;

        if (fieldType === 'categorical') {
          const select = document.createElement('select');
          select.id = filterDef.id;
          if (filterDef.multi) select.multiple = true;
          const values = (filterDef.options && filterDef.options.length ? filterDef.options : distinctValues(filterDef.field));
          values.forEach((value) => {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = String(value);
            select.appendChild(option);
          });
          wrapper.appendChild(select);
          return wrapper;
        }

        if (fieldType === 'date' || fieldType === 'datetime') {
          const extent = fieldExtent(filterDef.field, 'date');
          const preset = document.createElement('select');
          preset.id = filterDef.id + '__preset';
          ['', 'last_30_days', 'last_90_days', 'last_180_days'].forEach((value) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value ? value.replaceAll('_', ' ') : 'Custom range';
            preset.appendChild(option);
          });
          wrapper.appendChild(preset);
          const startInput = document.createElement('input');
          startInput.type = 'date';
          startInput.id = filterDef.id + '__start';
          const endInput = document.createElement('input');
          endInput.type = 'date';
          endInput.id = filterDef.id + '__end';
          if (extent.min !== null) startInput.value = new Date(extent.min).toISOString().slice(0, 10);
          if (extent.max !== null) endInput.value = new Date(extent.max).toISOString().slice(0, 10);
          preset.addEventListener('change', () => {
            if (!preset.value || extent.max === null) return;
            const end = new Date(extent.max);
            const start = new Date(end);
            const days = preset.value === 'last_30_days' ? 30 : preset.value === 'last_90_days' ? 90 : 180;
            start.setDate(start.getDate() - days);
            startInput.value = start.toISOString().slice(0, 10);
            endInput.value = end.toISOString().slice(0, 10);
          });
          wrapper.appendChild(startInput);
          wrapper.appendChild(endInput);
          return wrapper;
        }

        const extent = fieldExtent(filterDef.field, 'numeric');
        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.id = filterDef.id + '__min';
        minInput.placeholder = extent.min === null ? 'Min' : String(extent.min);
        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.id = filterDef.id + '__max';
        maxInput.placeholder = extent.max === null ? 'Max' : String(extent.max);
        wrapper.appendChild(minInput);
        wrapper.appendChild(maxInput);
        return wrapper;
      }

      function readFilterValue(filterDef) {
        const type = filterDef.resolvedType || inferFieldType(filterDef);
        if (type === 'categorical') {
          const select = document.getElementById(filterDef.id);
          return Array.from(select ? select.selectedOptions : []).map((option) => option.value);
        }
        if (type === 'date' || type === 'datetime') {
          return {
            start: document.getElementById(filterDef.id + '__start')?.value || '',
            end: document.getElementById(filterDef.id + '__end')?.value || '',
          };
        }
        return {
          min: document.getElementById(filterDef.id + '__min')?.value || '',
          max: document.getElementById(filterDef.id + '__max')?.value || '',
        };
      }

      function rowMatchesFilter(row, filterDef, value) {
        const type = filterDef.resolvedType || inferFieldType(filterDef);
        const rowValue = row[filterDef.field];
        if (type === 'categorical') {
          if (!value || !value.length) return true;
          return value.includes(String(rowValue));
        }
        if (type === 'date' || type === 'datetime') {
          const rowTime = normalizeComparable(rowValue, 'date');
          if (rowTime === null) return false;
          const start = value.start ? parseDateValue(value.start) : null;
          const end = value.end ? parseDateValue(value.end) : null;
          if (start && rowTime < start.getTime()) return false;
          if (end) {
            const inclusiveEnd = new Date(end);
            inclusiveEnd.setHours(23, 59, 59, 999);
            if (rowTime > inclusiveEnd.getTime()) return false;
          }
          return true;
        }
        const numericValue = normalizeComparable(rowValue, 'numeric');
        if (numericValue === null) return false;
        const minValue = parseNumericValue(value.min);
        const maxValue = parseNumericValue(value.max);
        if (minValue !== null && numericValue < minValue) return false;
        if (maxValue !== null && numericValue > maxValue) return false;
        return true;
      }

      function aggregateRows(rows, chartDef) {
        const map = new Map();
        rows.forEach((row) => {
          const xValue = row[chartDef.xField];
          const seriesValue = chartDef.seriesField ? row[chartDef.seriesField] : '__single__';
          const key = JSON.stringify([xValue, seriesValue]);
          if (!map.has(key)) {
            map.set(key, { x: xValue, series: seriesValue, count: 0, sum: 0, min: null, max: null, values: [] });
          }
          const bucket = map.get(key);
          bucket.count += 1;
          const yRaw = chartDef.yField ? parseNumericValue(row[chartDef.yField]) : null;
          if (yRaw !== null) {
            bucket.sum += yRaw;
            bucket.min = bucket.min === null ? yRaw : Math.min(bucket.min, yRaw);
            bucket.max = bucket.max === null ? yRaw : Math.max(bucket.max, yRaw);
            bucket.values.push(yRaw);
          }
        });

        const points = Array.from(map.values()).map((bucket) => {
          let yValue = bucket.count;
          switch (chartDef.aggregation) {
            case 'sum':
              yValue = bucket.sum;
              break;
            case 'avg':
            case 'mean':
              yValue = bucket.values.length ? bucket.sum / bucket.values.length : 0;
              break;
            case 'min':
              yValue = bucket.min === null ? 0 : bucket.min;
              break;
            case 'max':
              yValue = bucket.max === null ? 0 : bucket.max;
              break;
            case 'nunique':
            case 'count_distinct':
              yValue = new Set(bucket.values).size;
              break;
            case 'count':
            default:
              yValue = bucket.count;
              break;
          }
          return { x: bucket.x, y: yValue, series: bucket.series };
        });

        points.sort((left, right) => {
          const direction = chartDef.sortDirection === 'asc' ? 1 : -1;
          const leftValue = chartDef.sortBy === 'x' ? String(left.x ?? '') : Number(left.y ?? 0);
          const rightValue = chartDef.sortBy === 'x' ? String(right.x ?? '') : Number(right.y ?? 0);
          if (leftValue < rightValue) return -1 * direction;
          if (leftValue > rightValue) return 1 * direction;
          return 0;
        });

        return chartDef.limit > 0 ? points.slice(0, chartDef.limit) : points;
      }

      function buildPlotlyPayload(rows, chartDef) {
        const grouped = aggregateRows(rows, chartDef);
        const seriesValues = chartDef.seriesField
          ? [...new Set(grouped.map((item) => item.series))]
          : ['__single__'];
        const traces = seriesValues.map((seriesKey) => {
          const points = grouped.filter((item) => item.series === seriesKey);
          const trace = {
            type: chartDef.chartType === 'area' ? 'scatter' : chartDef.chartType,
            name: seriesKey === '__single__' ? chartDef.title : String(seriesKey),
            x: points.map((item) => item.x),
            y: points.map((item) => item.y),
          };
          if (chartDef.chartType === 'line' || chartDef.chartType === 'area') {
            trace.type = 'scatter';
            trace.mode = chartDef.mode || 'lines+markers';
            if (chartDef.chartType === 'area') trace.fill = 'tozeroy';
          }
          if (chartDef.chartType === 'scatter') {
            trace.mode = chartDef.mode || 'markers';
          }
          if (chartDef.chartType === 'bar' && chartDef.orientation === 'h') {
            trace.orientation = 'h';
            trace.x = points.map((item) => item.y);
            trace.y = points.map((item) => item.x);
          }
          if (chartDef.chartType === 'pie') {
            trace.type = 'pie';
            trace.labels = points.map((item) => item.x);
            trace.values = points.map((item) => item.y);
            delete trace.x;
            delete trace.y;
          }
          return trace;
        });
        return {
          data: traces,
          layout: {
            title: chartDef.title,
            template: 'plotly_white',
            colorway: ['#0f5c4d', '#c9792b', '#2f6db0', '#7b5ea7', '#d35f5f'],
            font: { family: '"Avenir Next", "Segoe UI", sans-serif', color: '#24313f' },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            margin: { t: 56, r: 24, b: 56, l: 56 },
            xaxis: chartDef.chartType === 'pie' ? undefined : { title: chartDef.xTitle || chartDef.xField },
            yaxis: chartDef.chartType === 'pie' ? undefined : { title: chartDef.yTitle || chartDef.yField || chartDef.aggregation },
            legend: { orientation: 'h' },
          },
          config: { responsive: true, displayModeBar: false },
        };
      }

      function renderCharts() {
        const filterState = Object.fromEntries(DASHBOARD_FILTER_SCHEMA.map((filterDef) => [filterDef.id, readFilterValue(filterDef)]));
        const filteredRows = DASHBOARD_DATASET.filter((row) =>
          DASHBOARD_FILTER_SCHEMA.every((filterDef) => rowMatchesFilter(row, filterDef, filterState[filterDef.id]))
        );

        DASHBOARD_CHART_DEFS.forEach((chartDef) => {
          const statusNode = document.getElementById(chartDef.divId + '-status');
          const plotNode = document.getElementById(chartDef.divId);
          if (!plotNode) return;
          const payload = buildPlotlyPayload(filteredRows, chartDef);
          if (!payload.data.length || !payload.data.some((trace) => (trace.x && trace.x.length) || (trace.labels && trace.labels.length))) {
            Plotly.purge(plotNode);
            if (statusNode) statusNode.textContent = 'No data matches the current filters for this chart.';
            return;
          }
          Plotly.newPlot(plotNode, payload.data, payload.layout, payload.config);
          if (statusNode) statusNode.textContent = filteredRows.length + ' rows match the current filters.';
        });
      }

      DASHBOARD_FILTER_SCHEMA.forEach((filterDef) => {
        controlHost.appendChild(createControl(filterDef));
      });
      if (applyButton) applyButton.addEventListener('click', renderCharts);
      if (resetButton) {
        resetButton.addEventListener('click', () => {
          DASHBOARD_FILTER_SCHEMA.forEach((filterDef) => {
            const type = filterDef.resolvedType || inferFieldType(filterDef);
            if (type === 'categorical') {
              const select = document.getElementById(filterDef.id);
              if (select) Array.from(select.options).forEach((option) => { option.selected = false; });
            } else if (type === 'date' || type === 'datetime') {
              const preset = document.getElementById(filterDef.id + '__preset');
              const start = document.getElementById(filterDef.id + '__start');
              const end = document.getElementById(filterDef.id + '__end');
              if (preset) preset.value = '';
              if (start) start.value = '';
              if (end) end.value = '';
            } else {
              const minInput = document.getElementById(filterDef.id + '__min');
              const maxInput = document.getElementById(filterDef.id + '__max');
              if (minInput) minInput.value = '';
              if (maxInput) maxInput.value = '';
            }
          });
          renderCharts();
        });
      }
      renderCharts();
    })();
"""


def _render_metric_cards(cards: List[Dict[str, str]], heading: str) -> str:
    if not cards:
        return ""
    card_html = []
    for card in cards:
        card_html.append(
            "<article class=\"metric-card\">"
            f"<div class=\"metric-label\">{html.escape(card.get('label', 'Metric'))}</div>"
            f"<div class=\"metric-value\">{html.escape(card.get('value', '0'))}</div>"
            f"<div class=\"metric-meta\">{html.escape(card.get('meta', ''))}</div>"
            "</article>"
        )
    return (
        "<section class=\"metric-section\">"
        f"<div class=\"metric-heading\">{html.escape(heading)}</div>"
        "<div class=\"metric-grid\">"
        + "".join(card_html)
        + "</div></section>"
    )


def render_summary_html(
    *,
    title: str,
    generated_at: str,
    summary_html: str,
    insights_html: str,
    metric_cards: List[Dict[str, str]],
    materialization_items: List[str],
    query_items: List[str],
    visualization_items: List[str],
) -> str:
    sections: List[str] = [
        "<section class=\"panel\">"
        "<div class=\"split-grid\">"
        "<div>"
        "<h2>Summary</h2>"
        f"<div class=\"agent-markdown\">{summary_html or '<p>No summary provided.</p>'}</div>"
        "</div>"
        "<div>"
        "<h2>Key Insights</h2>"
        f"<div class=\"agent-markdown\">{insights_html or '<p>No insights provided.</p>'}</div>"
        "</div>"
        "</div>"
        "</section>"
    ]
    if materialization_items:
        sections.append(
            "<section class=\"panel\">"
            "<h2>Warehouse Materializations</h2>"
            "<div class=\"stack\">"
            + "".join(materialization_items)
            + "</div></section>"
        )
    if query_items:
        sections.append(
            "<section class=\"panel\">"
            "<h2>SQL Queries</h2>"
            "<div class=\"stack\">"
            + "".join(query_items)
            + "</div></section>"
        )
    if visualization_items:
        sections.append(
            "<section class=\"panel\">"
            "<h2>Visualizations</h2>"
            "<div class=\"stack\">"
            + "".join(visualization_items)
            + "</div></section>"
        )

    return "\n".join(
        [
            "<!doctype html>",
            "<html lang=\"en\">",
            "<head>",
            "  <meta charset=\"utf-8\" />",
            "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
            f"  <title>{html.escape(title)}</title>",
            "  <style>",
            SUMMARY_CSS,
            "  </style>",
            f"  <script src=\"{PLOTLY_CDN}\"></script>",
            "</head>",
            "<body>",
            "  <div class=\"shell\">",
            "    <section class=\"hero\">",
            "      <div class=\"eyebrow\">Narrative Report</div>",
            f"      <h1>{html.escape(title)}</h1>",
            f"      <p>{html.escape(SUMMARY_SUBTITLE)}</p>",
            f"      <div class=\"hero-meta\">Generated {html.escape(generated_at)}</div>",
            _render_metric_cards(metric_cards, "Executive Snapshot"),
            "    </section>",
            *sections,
            "  </div>",
            "</body>",
            "</html>",
        ]
    )


def render_dashboard_html(
    *,
    title: str,
    description: str,
    generated_at: str,
    hero_meta: str,
    metric_cards: List[Dict[str, str]],
    filter_panel_html: str,
    primary_cards: List[str],
    appendix_cards: List[str],
    query_items: List[str],
    dataset_records: List[Dict[str, Any]],
    filter_config: List[Dict[str, Any]],
    chart_runtime_defs: List[Dict[str, Any]],
    dataset_schema: List[Dict[str, Any]],
    highlights_heading: str,
) -> str:
    primary_cards_html = "".join(primary_cards)
    appendix_html = (
        "<details class=\"appendix\">"
        "<summary>Static appendix charts</summary>"
        "<div class=\"chart-grid\">"
        + "".join(appendix_cards)
        + "</div></details>"
        if appendix_cards
        else ""
    )
    query_html = (
        "<details class=\"appendix\">"
        "<summary>Technical appendix</summary>"
        + "".join(query_items)
        + "</details>"
    )
    return "\n".join(
        [
            "<!doctype html>",
            "<html lang=\"en\">",
            "<head>",
            "  <meta charset=\"utf-8\" />",
            "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
            f"  <title>{html.escape(title)}</title>",
            "  <style>",
            DASHBOARD_CSS,
            "  </style>",
            f"  <script src=\"{PLOTLY_CDN}\"></script>",
            "</head>",
            "<body>",
            "  <div class=\"shell\">",
            "    <section class=\"hero\">",
            "      <div class=\"eyebrow\">Interactive Dashboard</div>",
            f"      <h1>{html.escape(title)}</h1>",
            f"      <p>{html.escape(description)}</p>",
            f"      <div class=\"hero-meta\">Generated {html.escape(generated_at)} • {html.escape(hero_meta)}</div>",
            _render_metric_cards(metric_cards, "Quick Pulse"),
            "    </section>",
            filter_panel_html,
            "    <section class=\"section\">",
            f"      <h2>{html.escape(highlights_heading)}</h2>",
            "      <div class=\"chart-grid\">",
            primary_cards_html,
            "      </div>",
            appendix_html,
            query_html,
            "    </section>",
            "  </div>",
            "  <script>",
            f"    const DASHBOARD_DATASET = {json.dumps(dataset_records, ensure_ascii=False)};",
            f"    const DASHBOARD_FILTER_SCHEMA = {json.dumps(filter_config, ensure_ascii=False)};",
            f"    const DASHBOARD_CHART_DEFS = {json.dumps(chart_runtime_defs, ensure_ascii=False)};",
            f"    const DASHBOARD_DATASET_SCHEMA = {json.dumps(dataset_schema, ensure_ascii=False)};",
            DASHBOARD_FILTER_SCRIPT,
            "  </script>",
            "</body>",
            "</html>",
        ]
    )
