import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

const primaryLinks = [
  { to: '/', label: 'Home' },
  { to: '/robo', label: 'Robo' },
  { to: '/plan', label: 'Plan' },
  { to: '/portfolio', label: 'Portfolio' }
];

const secondaryLinks = [
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/research', label: 'Research' },
  { to: '/activity', label: 'Activity' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/trading-system', label: 'System' },
  { to: '/discover', label: 'Discover' }
];

function navClass(isActive) {
  return `rounded-lg py-2 text-center font-semibold transition-all duration-200 ${
    isActive
      ? 'bg-[#173426] text-[#8cf5bd] ring-1 ring-[#26d07c]/35'
      : 'text-[#a9b8b8] hover:bg-[#172126]'
  }`;
}

export default function BottomNav() {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const moreActive = secondaryLinks.some(link => (
    location.pathname === link.to || location.pathname.startsWith(`${link.to}/`)
  ));

  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  return (
    <>
      {moreOpen && (
        <div className="lg:hidden fixed bottom-[4.1rem] left-2 right-2 z-40 rounded-lg border border-[#26363c] bg-[#11181b]/98 p-2 shadow-[0_18px_42px_rgba(0,0,0,0.42)] backdrop-blur-xl">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {secondaryLinks.map(link => (
              <NavLink
                key={`${link.to}-${link.label}`}
                to={link.to}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 font-semibold ${
                    isActive
                      ? 'bg-[#173426] text-[#8cf5bd] ring-1 ring-[#26d07c]/35'
                      : 'text-[#b8c8c7] hover:bg-[#172126]'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </div>
        </div>
      )}

      <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-[#0b1012]/96 border-t border-[#26363c] px-2 py-2 z-40 backdrop-blur-xl shadow-[0_-10px_24px_rgba(0,0,0,0.34)]">
        <div className="grid grid-cols-5 gap-2 text-[10px]">
          {primaryLinks.map(link => (
            <NavLink
              key={`${link.to}-${link.label}`}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) => navClass(isActive)}
            >
              {link.label}
            </NavLink>
          ))}
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(prev => !prev)}
            className={navClass(moreOpen || moreActive)}
          >
            More
          </button>
        </div>
      </nav>
    </>
  );
}
