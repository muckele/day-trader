import React, { useEffect, useMemo, useRef, useState } from 'react';
import Button from './ui/Button';
import Badge from './ui/Badge';

const TIMEFRAMES = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y'];
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 620;
const PLOT = { left: 58, right: 152, top: 36, height: 318 };
const VOLUME = { top: 370, height: 76 };
const RSI = { top: 470, height: 54 };
const MACD = { top: 548, height: 48 };
const LAYER_LABELS = {
  sma20: 'SMA 20',
  sma50: 'SMA 50',
  sma200: 'SMA 200',
  vwap20: 'VWAP 20',
  volumeProfile: 'Volume profile',
  comparison: 'Comparison',
  markers: 'Events'
};

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : 'N/A';
}

function formatCurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `$${numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCompact(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  if (Math.abs(numeric) >= 1000000) return `${(numeric / 1000000).toFixed(1)}M`;
  if (Math.abs(numeric) >= 1000) return `${(numeric / 1000).toFixed(1)}K`;
  return numeric.toLocaleString();
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

function fallbackTimeframes(chart = {}) {
  const daily = Array.isArray(chart.daily) ? chart.daily : [];
  const intraday = Array.isArray(chart.intraday) ? chart.intraday : [];
  return {
    '1D': { bars: intraday.length ? intraday : daily.slice(-1), markers: [], volumeProfile: [] },
    '5D': { bars: intraday.length ? intraday : daily.slice(-5), markers: [], volumeProfile: [] },
    '1M': { bars: daily.slice(-23), markers: [], volumeProfile: [] },
    '3M': { bars: daily.slice(-66), markers: [], volumeProfile: [] },
    '6M': { bars: daily.slice(-132), markers: [], volumeProfile: [] },
    YTD: { bars: daily, markers: [], volumeProfile: [] },
    '1Y': { bars: daily.slice(-252), markers: [], volumeProfile: [] },
    '5Y': { bars: daily.slice(-1260), markers: [], volumeProfile: [] }
  };
}

function scaleLinear(domainMin, domainMax, rangeMin, rangeMax) {
  const span = domainMax - domainMin || 1;
  return value => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

function pathFromPoints(points) {
  return points
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x, 2)} ${round(point.y, 2)}`)
    .join(' ');
}

function nearestIndexFromPointer(event, svgRef, count) {
  const rect = svgRef.current?.getBoundingClientRect();
  if (!rect || !count) return null;
  const x = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH;
  const plotWidth = VIEW_WIDTH - PLOT.left - PLOT.right;
  if (x < PLOT.left || x > PLOT.left + plotWidth) return null;
  return Math.max(0, Math.min(count - 1, Math.round(((x - PLOT.left) / plotWidth) * (count - 1))));
}

function normalizeComparisonSeries(row, visibleBars, xScale, yScale) {
  const series = Array.isArray(row.chart) ? row.chart : [];
  if (!series.length || !visibleBars.length) return [];
  const sliced = series.slice(-visibleBars.length);
  const base = toNumber(sliced[0]?.close);
  const selectedBase = toNumber(visibleBars[0]?.close);
  if (!base || !selectedBase) return [];
  return sliced.map((bar, index) => {
    const close = toNumber(bar.close);
    const syntheticPrice = close ? selectedBase * (close / base) : null;
    return {
      x: xScale(index),
      y: syntheticPrice ? yScale(syntheticPrice) : null
    };
  });
}

export default function ResearchChart({ symbol, chart, compare, className = '' }) {
  const svgRef = useRef(null);
  const [timeframe, setTimeframe] = useState('1Y');
  const [chartType, setChartType] = useState('candles');
  const [crosshairIndex, setCrosshairIndex] = useState(null);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [zoom, setZoom] = useState(null);
  const [layers, setLayers] = useState({
    sma20: true,
    sma50: true,
    sma200: false,
    vwap20: true,
    volumeProfile: true,
    comparison: true,
    markers: true
  });

  const timeframes = chart?.timeframes || fallbackTimeframes(chart);
  const frame = timeframes[timeframe] || timeframes['1Y'] || Object.values(timeframes)[0] || { bars: [] };
  const rawBars = useMemo(() => (Array.isArray(frame.bars) ? frame.bars : []), [frame.bars]);

  useEffect(() => {
    setCrosshairIndex(null);
    setDragStart(null);
    setDragEnd(null);
    setZoom(null);
  }, [timeframe, symbol]);

  const visibleBars = useMemo(() => {
    if (!zoom) return rawBars;
    return rawBars.slice(zoom.start, zoom.end + 1);
  }, [rawBars, zoom]);

  const plotWidth = VIEW_WIDTH - PLOT.left - PLOT.right;
  const xScale = useMemo(() => scaleLinear(0, Math.max(1, visibleBars.length - 1), PLOT.left, PLOT.left + plotWidth), [visibleBars.length, plotWidth]);

  const priceDomain = useMemo(() => {
    const values = visibleBars.flatMap(bar => [
      bar.high, bar.low, bar.close, bar.open, bar.sma20, bar.sma50, bar.sma200, bar.vwap20,
      frame.support, frame.resistance
    ]).map(Number).filter(Number.isFinite);
    if (!values.length) return [0, 1];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = Math.max((max - min) * 0.08, max * 0.002, 0.01);
    return [min - padding, max + padding];
  }, [visibleBars, frame.support, frame.resistance]);
  const yScale = useMemo(() => scaleLinear(priceDomain[0], priceDomain[1], PLOT.top + PLOT.height, PLOT.top), [priceDomain]);

  const volumeMax = useMemo(() => Math.max(...visibleBars.map(bar => Number(bar.volume || 0)), 1), [visibleBars]);
  const volumeY = useMemo(() => scaleLinear(0, volumeMax, VOLUME.top + VOLUME.height, VOLUME.top), [volumeMax]);
  const rsiY = useMemo(() => scaleLinear(0, 100, RSI.top + RSI.height, RSI.top), []);

  const macdDomain = useMemo(() => {
    const values = visibleBars.flatMap(bar => [bar.macd, bar.macdSignal, bar.macdHistogram]).map(Number).filter(Number.isFinite);
    const maxAbs = Math.max(...values.map(value => Math.abs(value)), 1);
    return [-maxAbs, maxAbs];
  }, [visibleBars]);
  const macdY = useMemo(() => scaleLinear(macdDomain[0], macdDomain[1], MACD.top + MACD.height, MACD.top), [macdDomain]);

  const candleWidth = Math.max(2, Math.min(12, plotWidth / Math.max(visibleBars.length, 1) * 0.58));
  const crosshairBar = crosshairIndex !== null ? visibleBars[crosshairIndex] : null;
  const markerByIndex = useMemo(() => {
    const source = Array.isArray(frame.markers) ? frame.markers : [];
    const startOffset = zoom ? zoom.start : 0;
    return source.reduce((acc, marker) => {
      const index = marker.index - startOffset;
      if (index >= 0 && index < visibleBars.length) {
        if (!acc[index]) acc[index] = [];
        acc[index].push(marker);
      }
      return acc;
    }, {});
  }, [frame.markers, visibleBars.length, zoom]);

  const lineFor = key => pathFromPoints(visibleBars.map((bar, index) => ({
    x: xScale(index),
    y: toNumber(bar[key]) !== null ? yScale(Number(bar[key])) : null
  })));

  const handleToggle = key => {
    setLayers(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleMouseMove = event => {
    const index = nearestIndexFromPointer(event, svgRef, visibleBars.length);
    setCrosshairIndex(index);
    if (dragStart !== null && index !== null) setDragEnd(index);
  };

  const handleMouseDown = event => {
    const index = nearestIndexFromPointer(event, svgRef, visibleBars.length);
    if (index !== null) {
      setDragStart(index);
      setDragEnd(index);
    }
  };

  const handleMouseUp = () => {
    if (dragStart !== null && dragEnd !== null && Math.abs(dragEnd - dragStart) > 4) {
      const localStart = Math.min(dragStart, dragEnd);
      const localEnd = Math.max(dragStart, dragEnd);
      const base = zoom ? zoom.start : 0;
      setZoom({ start: base + localStart, end: base + localEnd });
    }
    setDragStart(null);
    setDragEnd(null);
  };

  if (!visibleBars.length) {
    return (
      <div className={`rt-panel-muted p-6 text-sm text-[#8ba09f] ${className}`}>
        No chart bars are available for {symbol || 'this symbol'}.
      </div>
    );
  }

  const dragSelection = dragStart !== null && dragEnd !== null
    ? {
        x: Math.min(xScale(dragStart), xScale(dragEnd)),
        width: Math.abs(xScale(dragEnd) - xScale(dragStart))
      }
    : null;

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-2">
          {TIMEFRAMES.map(item => (
            <button
              key={item}
              type="button"
              onClick={() => setTimeframe(item)}
              className={`rounded-lg px-3 py-2 text-xs font-bold ${timeframe === item ? 'bg-[#173426] text-[#8cf5bd]' : 'bg-[#10171a] text-[#b8c8c7] hover:bg-[#172126]'}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setChartType(chartType === 'candles' ? 'line' : 'candles')}
            className="rounded-lg bg-[#10171a] px-3 py-2 text-xs font-bold text-[#b8c8c7] hover:bg-[#172126]"
          >
            {chartType === 'candles' ? 'Candles' : 'Line'}
          </button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setZoom(null)} disabled={!zoom}>
            Reset zoom
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-[#b8c8c7]">
        {Object.keys(layers).map(layer => (
          <label key={layer} className="inline-flex items-center gap-2">
            <input type="checkbox" checked={layers[layer]} onChange={() => handleToggle(layer)} />
            {LAYER_LABELS[layer] || layer}
          </label>
        ))}
      </div>

      <div className="relative overflow-hidden rounded-lg border border-[#26363c] bg-[#081012]">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          className="block h-[38rem] w-full touch-none select-none"
          role="img"
          aria-label={`${symbol || 'Symbol'} professional research chart`}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setCrosshairIndex(null)}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onDoubleClick={() => setZoom(null)}
        >
          <rect x="0" y="0" width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="#081012" />
          {[0, 0.25, 0.5, 0.75, 1].map(step => {
            const y = PLOT.top + PLOT.height * step;
            const value = priceDomain[1] - (priceDomain[1] - priceDomain[0]) * step;
            return (
              <g key={step}>
                <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={y} y2={y} stroke="#1c2a2f" strokeDasharray="3 4" />
                <text x={PLOT.left + plotWidth + 8} y={y + 4} fill="#8ba09f" fontSize="12">{formatCurrency(value)}</text>
              </g>
            );
          })}

          {chartType === 'candles' ? visibleBars.map((bar, index) => {
            const x = xScale(index);
            const openY = yScale(bar.open);
            const closeY = yScale(bar.close);
            const highY = yScale(bar.high);
            const lowY = yScale(bar.low);
            const up = Number(bar.close) >= Number(bar.open);
            return (
              <g key={`${bar.time}-${index}`}>
                <line x1={x} x2={x} y1={highY} y2={lowY} stroke={up ? '#8cf5bd' : '#ff8fa3'} strokeWidth="1.4" />
                <rect
                  x={x - candleWidth / 2}
                  y={Math.min(openY, closeY)}
                  width={candleWidth}
                  height={Math.max(1.5, Math.abs(closeY - openY))}
                  fill={up ? '#1f9f65' : '#c94460'}
                  stroke={up ? '#8cf5bd' : '#ff8fa3'}
                  strokeWidth="0.6"
                  rx="1"
                />
              </g>
            );
          }) : (
            <path d={lineFor('close')} fill="none" stroke="#edf5f4" strokeWidth="2.2" />
          )}

          {layers.sma20 && <path d={lineFor('sma20')} fill="none" stroke="#26d07c" strokeWidth="1.6" />}
          {layers.sma50 && <path d={lineFor('sma50')} fill="none" stroke="#66a6ff" strokeWidth="1.5" />}
          {layers.sma200 && <path d={lineFor('sma200')} fill="none" stroke="#c6a7ff" strokeWidth="1.4" />}
          {layers.vwap20 && <path d={lineFor('vwap20')} fill="none" stroke="#ffd77a" strokeWidth="1.5" />}

          {frame.support && (
            <g>
              <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={yScale(frame.support)} y2={yScale(frame.support)} stroke="#8cf5bd" strokeDasharray="7 5" opacity="0.55" />
              <text x={PLOT.left + 8} y={yScale(frame.support) - 6} fill="#8cf5bd" fontSize="12">Support {formatCurrency(frame.support)}</text>
            </g>
          )}
          {frame.resistance && (
            <g>
              <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={yScale(frame.resistance)} y2={yScale(frame.resistance)} stroke="#ffb5c2" strokeDasharray="7 5" opacity="0.55" />
              <text x={PLOT.left + 8} y={yScale(frame.resistance) + 16} fill="#ffb5c2" fontSize="12">Resistance {formatCurrency(frame.resistance)}</text>
            </g>
          )}

          {layers.comparison && (compare?.rows || []).slice(0, 4).filter(row => row.symbol !== symbol).map((row, rowIndex) => (
            <path
              key={row.symbol}
              d={pathFromPoints(normalizeComparisonSeries(row, visibleBars, xScale, yScale))}
              fill="none"
              stroke={['#f4b942', '#66a6ff', '#c6a7ff', '#ff8fa3'][rowIndex % 4]}
              strokeWidth="1.3"
              opacity="0.72"
            />
          ))}

          {layers.markers && Object.entries(markerByIndex).map(([index, markers]) => {
            const x = xScale(Number(index));
            return markers.slice(0, 3).map((marker, markerIndex) => (
              <g key={marker.id} transform={`translate(${x}, ${PLOT.top + 16 + markerIndex * 18})`}>
                <circle r="7" fill={marker.sentiment === 'negative' ? '#3a1820' : '#173426'} stroke={marker.sentiment === 'negative' ? '#ff8fa3' : '#8cf5bd'} />
                <text y="4" textAnchor="middle" fill="#edf5f4" fontSize="9" fontWeight="700">{marker.label}</text>
              </g>
            ));
          })}

          {visibleBars.map((bar, index) => {
            const x = xScale(index);
            const barWidth = Math.max(1, plotWidth / Math.max(visibleBars.length, 1) * 0.62);
            const y = volumeY(Number(bar.volume || 0));
            return (
              <rect
                key={`volume-${bar.time}-${index}`}
                x={x - barWidth / 2}
                y={y}
                width={barWidth}
                height={VOLUME.top + VOLUME.height - y}
                fill={Number(bar.close) >= Number(bar.open) ? '#24533d' : '#5a2430'}
                opacity="0.72"
              />
            );
          })}
          <text x={PLOT.left} y={VOLUME.top - 8} fill="#8ba09f" fontSize="12">Volume</text>

          {layers.volumeProfile && (frame.volumeProfile || []).map(bucket => {
            const y = yScale(bucket.mid);
            const width = Math.max(2, Number(bucket.share || 0) * 92);
            return (
              <rect
                key={`${bucket.low}-${bucket.high}`}
                x={PLOT.left + plotWidth + 48}
                y={y - 4}
                width={width}
                height="8"
                fill="#28414a"
                opacity="0.72"
              />
            );
          })}
          {layers.volumeProfile && <text x={PLOT.left + plotWidth + 48} y={PLOT.top + 14} fill="#8ba09f" fontSize="12">Profile</text>}

          <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={rsiY(70)} y2={rsiY(70)} stroke="#ffb5c2" strokeDasharray="4 4" opacity="0.45" />
          <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={rsiY(30)} y2={rsiY(30)} stroke="#8cf5bd" strokeDasharray="4 4" opacity="0.45" />
          <path d={pathFromPoints(visibleBars.map((bar, index) => ({ x: xScale(index), y: toNumber(bar.rsi14) !== null ? rsiY(bar.rsi14) : null })))} fill="none" stroke="#ffd77a" strokeWidth="1.5" />
          <text x={PLOT.left} y={RSI.top - 8} fill="#8ba09f" fontSize="12">RSI 14</text>

          <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={macdY(0)} y2={macdY(0)} stroke="#26363c" />
          {visibleBars.map((bar, index) => {
            const value = Number(bar.macdHistogram);
            if (!Number.isFinite(value)) return null;
            const x = xScale(index);
            const zero = macdY(0);
            const y = macdY(value);
            const barWidth = Math.max(1, plotWidth / Math.max(visibleBars.length, 1) * 0.54);
            return (
              <rect
                key={`macd-${bar.time}-${index}`}
                x={x - barWidth / 2}
                y={Math.min(zero, y)}
                width={barWidth}
                height={Math.max(1, Math.abs(zero - y))}
                fill={value >= 0 ? '#26d07c' : '#ff8fa3'}
                opacity="0.56"
              />
            );
          })}
          <path d={pathFromPoints(visibleBars.map((bar, index) => ({ x: xScale(index), y: toNumber(bar.macd) !== null ? macdY(bar.macd) : null })))} fill="none" stroke="#66a6ff" strokeWidth="1.2" />
          <path d={pathFromPoints(visibleBars.map((bar, index) => ({ x: xScale(index), y: toNumber(bar.macdSignal) !== null ? macdY(bar.macdSignal) : null })))} fill="none" stroke="#ffd77a" strokeWidth="1.2" />
          <text x={PLOT.left} y={MACD.top - 8} fill="#8ba09f" fontSize="12">MACD</text>

          {crosshairIndex !== null && crosshairBar && (
            <g>
              <line x1={xScale(crosshairIndex)} x2={xScale(crosshairIndex)} y1={PLOT.top} y2={VIEW_HEIGHT - 22} stroke="#d9e5e4" strokeDasharray="4 4" opacity="0.45" />
              <line x1={PLOT.left} x2={PLOT.left + plotWidth} y1={yScale(crosshairBar.close)} y2={yScale(crosshairBar.close)} stroke="#d9e5e4" strokeDasharray="4 4" opacity="0.25" />
              <rect x={xScale(crosshairIndex) > 700 ? 594 : xScale(crosshairIndex) + 14} y="48" width="236" height={markerByIndex[crosshairIndex]?.length ? 136 : 110} rx="8" fill="#10171a" stroke="#31444b" />
              <text x={xScale(crosshairIndex) > 700 ? 608 : xScale(crosshairIndex) + 28} y="70" fill="#edf5f4" fontSize="13" fontWeight="700">{formatDate(crosshairBar.time)}</text>
              <text x={xScale(crosshairIndex) > 700 ? 608 : xScale(crosshairIndex) + 28} y="92" fill="#b8c8c7" fontSize="12">O {formatCurrency(crosshairBar.open)} H {formatCurrency(crosshairBar.high)}</text>
              <text x={xScale(crosshairIndex) > 700 ? 608 : xScale(crosshairIndex) + 28} y="112" fill="#b8c8c7" fontSize="12">L {formatCurrency(crosshairBar.low)} C {formatCurrency(crosshairBar.close)}</text>
              <text x={xScale(crosshairIndex) > 700 ? 608 : xScale(crosshairIndex) + 28} y="132" fill="#8ba09f" fontSize="12">Vol {formatCompact(crosshairBar.volume)} RSI {round(crosshairBar.rsi14, 1)} ATR {round(crosshairBar.atr14, 2)}</text>
              {markerByIndex[crosshairIndex]?.[0] && (
                <text x={xScale(crosshairIndex) > 700 ? 608 : xScale(crosshairIndex) + 28} y="154" fill="#ffd77a" fontSize="11">
                  {String(markerByIndex[crosshairIndex][0].title || '').slice(0, 34)}
                </text>
              )}
            </g>
          )}

          {dragSelection && dragSelection.width > 2 && (
            <rect x={dragSelection.x} y={PLOT.top} width={dragSelection.width} height={PLOT.height} fill="#8cf5bd" opacity="0.12" />
          )}
        </svg>

        <div className="flex flex-wrap items-center gap-2 border-t border-[#26363c] px-4 py-3 text-xs text-[#8ba09f]">
          <Badge variant="neutral">{visibleBars.length} bars</Badge>
          <span>Drag across the price chart to zoom. Double-click to reset.</span>
          {layers.comparison && (compare?.rows || []).filter(row => row.symbol !== symbol).slice(0, 4).map(row => (
            <span key={row.symbol} className="font-semibold text-[#d9e5e4]">{row.symbol}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
