'use client';

import type { MarketHistoryPoint } from '@zoryqon/contracts';

export function PriceChart({ points }: { points: MarketHistoryPoint[] }) {
  if (points.length < 2) {
    return (
      <div className="chart-empty large">Price history will appear after confirmed trades.</div>
    );
  }
  const values = points.map((point) => Number(point.priceAtoms));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const coordinates = values.map((value, index) => ({
    x: (index / (values.length - 1)) * 800,
    y: 250 - ((value - min) / range) * 220,
  }));
  const line = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
  const fill = `${line} L800 270 L0 270 Z`;
  return (
    <svg
      viewBox="0 0 800 270"
      preserveAspectRatio="none"
      role="img"
      aria-label="Confirmed market price history"
    >
      <defs>
        <linearGradient id="history-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#65f5c7" stopOpacity=".28" />
          <stop offset="100%" stopColor="#65f5c7" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="chart-fill" d={fill} fill="url(#history-fill)" />
      <path className="chart-line" d={line} fill="none" />
    </svg>
  );
}
