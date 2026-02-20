// src/pages/Register.js
import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate, Link } from 'react-router-dom';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import { getApiError } from '../utils/api';

export default function Register() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async e => {
    e.preventDefault();
    setError(''); 
    setSuccess('');
    try {
      // 1. POST to /api/register
      await axios.post('/api/register', { username, password });
      // 2. Show success and redirect to login after a brief pause
      setSuccess('Account created! Redirecting to login…');
      setTimeout(() => navigate('/login'), 1500);
    } catch (err) {
      setError(getApiError(err));
    }
  };

  return (
    <div className="max-w-md mx-auto">
      <Card className="p-6">
        <h2 className="text-2xl font-semibold text-slate-900 dark:text-white mb-4">Sign Up</h2>
        {error && <p className="text-red-500 mb-2">{error}</p>}
        {success && <p className="text-emerald-500 mb-2">{success}</p>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            className="border border-slate-200/80 dark:border-slate-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-900"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="border border-slate-200/80 dark:border-slate-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-900"
            required
          />
          <Button type="submit">Create Account</Button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link to="/login" className="text-slate-900 dark:text-white underline">
            Log in
          </Link>
        </p>
      </Card>
    </div>
  );
}
