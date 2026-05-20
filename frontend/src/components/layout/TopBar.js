import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '../ui/Badge';
import { useMarketStatus } from '../../hooks/useMarketStatus';

export default function TopBar() {
  const { status, nextOpen, nextClose, countdown } = useMarketStatus();

  const isOpen = status === 'OPEN';
  const nextTime = isOpen ? nextClose : nextOpen;

  return (
    <header className="sticky top-0 z-40 border-b border-[#26363c] bg-[#0b1012]/92 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-lg sm:text-xl font-extrabold tracking-tight text-[#edf5f4]">
              Day<span className="text-[#26d07c]">Trader</span>
            </Link>
            <span className="hidden sm:inline text-[10px] uppercase tracking-[0.24em] text-[#8ba09f]">
              Paper Lab
            </span>
          </div>
          <Badge variant={isOpen ? 'success' : 'neutral'}>
            {isOpen ? 'Market Open' : 'Market Closed'}
          </Badge>
          {nextTime && (
            <span className="text-xs text-[#a9b8b8] tracking-wide">
              {isOpen ? 'Closes' : 'Opens'} {new Date(nextTime).toLocaleTimeString()}
              {countdown ? ` · ${countdown}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="solid">PAPER MODE</Badge>
        </div>
      </div>
    </header>
  );
}
