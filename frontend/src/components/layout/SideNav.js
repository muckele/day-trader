import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import axios from 'axios';
import Button from '../ui/Button';

const links = [
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/robo', label: 'Robo Trader' },
  { to: '/plan', label: 'Trade Plan' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/activity', label: 'Activity' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/discover', label: 'Discover' }
];

export default function SideNav() {
  const navigate = useNavigate();
  const [isAuthed, setIsAuthed] = useState(false);

  useEffect(() => {
    setIsAuthed(!!localStorage.getItem('token'));
  }, []);

  const handleSignOut = async () => {
    try {
      await axios.post('/api/logout');
    } catch (err) {
      console.error('Logout log failed:', err);
    } finally {
      localStorage.removeItem('token');
      setIsAuthed(false);
      navigate('/login');
    }
  };

  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:shrink-0 lg:gap-3 lg:sticky lg:top-24 lg:h-fit">
      <div className="bg-[#101913]/88 border border-emerald-900/55 rounded-2xl p-4 shadow-[0_14px_34px_rgba(0,0,0,0.5)]">
        <p className="text-xs uppercase tracking-[0.2em] text-emerald-100/42">Navigation</p>
        <nav className="mt-3 flex flex-col gap-2 text-sm">
          {links.map(link => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-[linear-gradient(90deg,rgba(0,200,5,0.28)_0%,rgba(18,31,24,0.88)_100%)] text-[#8cffab] ring-1 ring-[#00c805]/45 shadow-[inset_0_0_0_1px_rgba(0,200,5,0.16)]'
                    : 'text-emerald-100/78 hover:bg-[#1a261f] hover:text-emerald-200'
                }`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </div>
      {isAuthed && (
        <Button variant="ghost" size="sm" onClick={handleSignOut} className="justify-start text-emerald-100/80">
          Sign Out
        </Button>
      )}
    </aside>
  );
}
