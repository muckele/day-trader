// src/index.js

// ─── 1. ALL IMPORTS AT THE TOP ────────────────────────────────────────────────
import axios from 'axios';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// ─── 2. CONFIGURE AXIOS INTERCEPTORS ────────────────────────────────────────
// Attach token to every request
axios.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Redirect to /login on 401 Unauthorized
axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// ─── 3. RENDER YOUR APP ──────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// ─── 4. OPTIONAL: PERFORMANCE LOGGING ─────────────────────────────────────────
reportWebVitals();
