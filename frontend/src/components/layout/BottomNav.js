import React from 'react';
import { NavLink } from 'react-router-dom';

const links = [
  { to: '/', label: 'Home' },
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/plan', label: 'Plan' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/activity', label: 'Activity' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/discover', label: 'Discover' }
];

export default function BottomNav() {
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-slate-950 border-t border-slate-200/80 dark:border-slate-800 px-2 py-2 z-40">
      <div className="grid grid-cols-7 gap-2 text-[10px]">
        {links.map(link => (
          <NavLink
            key={`${link.to}-${link.label}`}
            to={link.to}
            end={link.to === '/'}
            className={({ isActive }) =>
              `rounded-lg py-2 text-center font-semibold transition ${
                isActive
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : 'text-slate-500 dark:text-slate-300'
              }`
            }
          >
            {link.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
