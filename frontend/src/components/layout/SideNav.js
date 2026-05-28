import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import Button from '../ui/Button';
import { useAuth } from '../../context/AuthContext';

const links = [
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/research', label: 'Research' },
  { to: '/robo', label: 'Robo Trader' },
  { to: '/plan', label: 'Trade Plan' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/activity', label: 'Activity' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/trading-system', label: 'Trading System' },
  { to: '/discover', label: 'Discover' }
];

export default function SideNav() {
  const navigate = useNavigate();
  const { isAuthenticated, signOut } = useAuth();

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (err) {
      console.error('Logout log failed:', err);
    } finally {
      navigate('/login');
    }
  };

  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:shrink-0 lg:gap-3 lg:sticky lg:top-24 lg:h-fit">
      <div className="bg-[#11181b]/92 border border-[#26363c] rounded-lg p-3 shadow-[0_18px_42px_rgba(0,0,0,0.28)]">
        <p className="px-2 text-xs uppercase tracking-[0.16em] text-[#8ba09f]">Navigation</p>
        <nav className="mt-3 flex flex-col gap-2 text-sm">
          {links.map(link => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-[#173426] text-[#8cf5bd] ring-1 ring-[#26d07c]/35'
                    : 'text-[#b8c8c7] hover:bg-[#172126] hover:text-[#edf5f4]'
                }`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </div>
      {isAuthenticated && (
        <Button variant="ghost" size="sm" onClick={handleSignOut} className="justify-start">
          Sign Out
        </Button>
      )}
    </aside>
  );
}
