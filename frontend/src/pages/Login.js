// src/pages/Login.js
import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate, Link } from 'react-router-dom';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import { getApiError } from '../utils/api';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    try {
      // 1. POST credentials
      const res = await axios.post('/api/login', { username, password });
      // 2. Store token
      localStorage.setItem('token', res.data.token);
      // 3. Redirect to home
      navigate('/');
    } catch (err) {
      setError(getApiError(err));
    }
  };

  return (
    <div className="max-w-md mx-auto">
      <Card className="p-6">
        <h2 className="text-2xl font-semibold text-slate-900 dark:text-white mb-4">Login</h2>
        {error && <p className="text-red-500 mb-2">{error}</p>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            className="border border-emerald-900/70 rounded-lg px-3 py-2 text-sm bg-[#0f1913] text-emerald-50 placeholder:text-emerald-100/35 focus:outline-none focus:ring-2 focus:ring-[#00c805]/35"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="border border-emerald-900/70 rounded-lg px-3 py-2 text-sm bg-[#0f1913] text-emerald-50 placeholder:text-emerald-100/35 focus:outline-none focus:ring-2 focus:ring-[#00c805]/35"
            required
          />
          <Button type="submit">Log In</Button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-500">
          Don&apos;t have an account?{' '}
          <Link to="/register" className="text-slate-900 dark:text-white underline">
            Sign up
          </Link>
        </p>
      </Card>
    </div>
  );
}
