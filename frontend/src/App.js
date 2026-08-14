// src/App.js
import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import PrivateRoute from './components/PrivateRoute';
import { AuthProvider } from './context/AuthContext';

const Register = lazy(() => import('./pages/Register'));
const Home = lazy(() => import('./pages/Home'));
const Stock = lazy(() => import('./pages/Stock'));
const Login = lazy(() => import('./pages/Login'));
const Portfolio = lazy(() => import('./pages/Portfolio'));
const Activity = lazy(() => import('./pages/Activity'));
const Discover = lazy(() => import('./pages/Discover'));
const Analytics = lazy(() => import('./pages/Analytics'));
const TradePlan = lazy(() => import('./pages/TradePlan'));
const RoboTrader = lazy(() => import('./pages/RoboTrader'));
const TradingSystem = lazy(() => import('./pages/TradingSystem'));
const Research = lazy(() => import('./pages/Research'));

export default function App() {
  const registrationEnabled = import.meta.env.DEV || import.meta.env.VITE_REGISTRATION_ENABLED === 'true';
  return (
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true
      }}
    >
      <AuthProvider>
        <AppLayout>
          <Suspense fallback={<div className="p-6 text-sm text-[#8ba09f]">Loading page...</div>}>
            <Routes>
            {/* Public route */}
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={registrationEnabled ? <Register /> : <Navigate to="/login" replace />} />

            {/* Protected routes */}
            <Route
              path="/"
              element={
                <PrivateRoute>
                  <Home />
                </PrivateRoute>
              }
            />
            <Route
              path="/watchlist"
              element={
                <PrivateRoute>
                  <Home />
                </PrivateRoute>
              }
            />
            <Route
              path="/stock/:symbol"
              element={
                <PrivateRoute>
                  <Stock />
                </PrivateRoute>
              }
            />
            <Route
              path="/research"
              element={
                <PrivateRoute>
                  <Research />
                </PrivateRoute>
              }
            />
            <Route
              path="/research/:symbol"
              element={
                <PrivateRoute>
                  <Research />
                </PrivateRoute>
              }
            />
            <Route
              path="/plan"
              element={
                <PrivateRoute>
                  <TradePlan />
                </PrivateRoute>
              }
            />
            <Route
              path="/portfolio"
              element={
                <PrivateRoute>
                  <Portfolio />
                </PrivateRoute>
              }
            />
            <Route
              path="/activity"
              element={
                <PrivateRoute>
                  <Activity />
                </PrivateRoute>
              }
            />
            <Route
              path="/analytics"
              element={
                <PrivateRoute>
                  <Analytics />
                </PrivateRoute>
              }
            />
            <Route
              path="/discover"
              element={
                <PrivateRoute>
                  <Discover />
                </PrivateRoute>
              }
            />
            <Route
              path="/robo"
              element={
                <PrivateRoute>
                  <RoboTrader />
                </PrivateRoute>
              }
            />
            <Route
              path="/trading-system"
              element={
                <PrivateRoute>
                  <TradingSystem />
                </PrivateRoute>
              }
            />
            </Routes>
          </Suspense>
        </AppLayout>
      </AuthProvider>
    </BrowserRouter>
  );
}
