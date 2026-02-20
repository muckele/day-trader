import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import axios from 'axios';
import Button from '../ui/Button';

const links = [
  { to: '/watchlist', label: 'Watchlist' },
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
    <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:shrink-0 lg:gap-3">
      <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-4 shadow-sm">
        <p className="text-xs uppercase tracking-wide text-slate-400">Navigation</p>
        <nav className="mt-3 flex flex-col gap-2 text-sm">
          {links.map(link => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 font-medium transition ${
                  isActive
                    ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
                }`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </div>
      {isAuthed && (
        <Button variant="ghost" size="sm" onClick={handleSignOut} className="justify-start">
          Sign Out
        </Button>
      )}
    </aside>
  );
}
