// src/index.js

// ─── 1. ALL IMPORTS AT THE TOP ────────────────────────────────────────────────
import axios from 'axios';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { getApiBaseUrl } from './utils/api';

const savedTheme = localStorage.getItem('daytrader-theme');
if (savedTheme === 'dark') {
  document.documentElement.classList.add('dark');
}

// ─── 2. CONFIGURE AXIOS ─────────────────────────────────────────────────────
const apiBaseUrl = getApiBaseUrl();
if (apiBaseUrl) {
  axios.defaults.baseURL = apiBaseUrl;
}

// ─── 3. CONFIGURE AXIOS INTERCEPTORS ────────────────────────────────────────
// Attach JWT token (if present) to every request
axios.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Redirect to /login on any 401 Unauthorized response
axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
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
