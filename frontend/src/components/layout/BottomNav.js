import React from 'react';
import { NavLink } from 'react-router-dom';

const links = [
  { to: '/', label: 'Home' },
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/robo', label: 'Robo' },
  { to: '/plan', label: 'Plan' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/activity', label: 'Activity' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/discover', label: 'Discover' }
];

export default function BottomNav() {
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-[#0a100c]/96 border-t border-emerald-900/65 px-2 py-2 z-40 backdrop-blur-xl shadow-[0_-10px_24px_rgba(0,0,0,0.45)]">
      <div className="grid grid-cols-8 gap-2 text-[10px]">
        {links.map(link => (
          <NavLink
            key={`${link.to}-${link.label}`}
            to={link.to}
            end={link.to === '/'}
            className={({ isActive }) =>
              `rounded-lg py-2 text-center font-semibold transition-all duration-200 ${
                isActive
                  ? 'bg-[linear-gradient(180deg,#00c805_0%,#0cb63a_100%)] text-[#041207] shadow-[0_0_0_1px_rgba(0,200,5,0.35)]'
                  : 'text-emerald-100/60 hover:bg-[#16221b]'
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
