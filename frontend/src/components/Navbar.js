import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar() {
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
    <nav className="bg-white border-b border-gray-200">
      <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-lg font-bold text-gray-900">
            DayTrader
          </Link>
          <span className="text-xs font-semibold bg-gray-900 text-white px-2 py-1 rounded-full">
            PAPER MODE
          </span>
        </div>
        <div className="flex items-center gap-4 text-sm text-gray-600">
          <Link to="/" className="hover:text-gray-900">Watchlist</Link>
          <Link to="/portfolio" className="hover:text-gray-900">Portfolio</Link>
          <Link to="/activity" className="hover:text-gray-900">Activity</Link>
          {isAuthenticated ? (
            <button
              onClick={handleSignOut}
              className="text-sm font-medium text-gray-700 hover:text-gray-900"
            >
              Sign Out
            </button>
          ) : (
            <>
              <Link to="/login" className="hover:text-gray-900">Log In</Link>
              <Link to="/register" className="hover:text-gray-900">Sign Up</Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
