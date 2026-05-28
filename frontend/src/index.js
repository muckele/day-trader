// src/index.js

// ─── 1. ALL IMPORTS AT THE TOP ────────────────────────────────────────────────
import axios from 'axios';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { getApiBaseUrl } from './utils/api';

document.documentElement.classList.add('dark');
localStorage.setItem('daytrader-theme', 'dark');

// ─── 2. CONFIGURE AXIOS ─────────────────────────────────────────────────────
const apiBaseUrl = getApiBaseUrl();
if (apiBaseUrl) {
  axios.defaults.baseURL = apiBaseUrl;
}
axios.defaults.withCredentials = true;

// ─── 3. CONFIGURE AXIOS INTERCEPTORS ────────────────────────────────────────
localStorage.removeItem('token');

// Redirect to /login on any 401 Unauthorized response
axios.interceptors.response.use(
  response => response,
  error => {
    const requestUrl = String(error.config?.url || '');
    if (
      error.response?.status === 401
      && !requestUrl.includes('/api/me')
      && window.location.pathname !== '/login'
    ) {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// ─── 4. RENDER YOUR APP ──────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// ─── 5. OPTIONAL: PERFORMANCE LOGGING ─────────────────────────────────────────
reportWebVitals();
