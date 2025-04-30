import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';

export default function Navbar() {
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
    <nav style={{
      display: 'flex',
      justifyContent: 'space-between',
      padding: '10px 20px',
      borderBottom: '1px solid #ddd'
    }}>
      <Link to="/" style={{ textDecoration: 'none', fontWeight: 'bold' }}>
        Day Trader
      </Link>
      <div style={{ display: 'flex', gap: 16 }}>
        {isAuthed ? (
          <button
            onClick={handleSignOut}
            style={{ padding: '6px 12px', cursor: 'pointer' }}
          >
            Sign Out
          </button>
        ) : (
          <>
            <Link to="/login" style={{ textDecoration: 'none' }}>Log In</Link>
            <Link to="/register" style={{ textDecoration: 'none' }}>Sign Up</Link>
          </>
        )}
      </div>
    </nav>
  );
}
