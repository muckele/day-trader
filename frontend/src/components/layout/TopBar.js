import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import { useMarketStatus } from '../../hooks/useMarketStatus';
import { useTheme } from '../../hooks/useTheme';

export default function TopBar() {
  const { status, nextOpen, nextClose, countdown } = useMarketStatus();
  const { theme, toggleTheme } = useTheme();

  const isOpen = status === 'OPEN';
  const nextTime = isOpen ? nextClose : nextOpen;

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
      <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-lg font-bold text-slate-900 dark:text-white">
            DayTrader
          </Link>
          <Badge variant={isOpen ? 'success' : 'neutral'}>
            {isOpen ? 'Market Open' : 'Market Closed'}
          </Badge>
          {nextTime && (
            <span className="text-xs text-slate-500 dark:text-slate-300">
              {isOpen ? 'Closes' : 'Opens'} {new Date(nextTime).toLocaleTimeString()}
              {countdown ? ` · ${countdown}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="solid">PAPER MODE</Badge>
          <Button variant="secondary" size="sm" onClick={toggleTheme}>
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </Button>
        </div>
      </div>
    </header>
  );
}
