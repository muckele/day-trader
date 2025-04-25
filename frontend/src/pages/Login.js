// src/pages/Login.js
import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

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
      // 4. Show error
      setError(err.response?.data?.message || err.message);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-20 p-6 border rounded shadow">
      <h2 className="text-2xl mb-4">Login</h2>
      {error && <p className="text-red-500 mb-2">{error}</p>}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          className="border p-2"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="border p-2"
          required
        />
        <button type="submit" className="bg-blue-600 text-white p-2 rounded">
          Log In
        </button>
      </form>
    </div>
  );
}
