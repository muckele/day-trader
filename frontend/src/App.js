// src/App.js
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import Register from './pages/Register';
import Home from './pages/Home';
import Stock from './pages/Stock';
import Login from './pages/Login';
import PrivateRoute from './components/PrivateRoute';
import Portfolio from './pages/Portfolio';
import Activity from './pages/Activity';
import Discover from './pages/Discover';
import Analytics from './pages/Analytics';
import TradePlan from './pages/TradePlan';

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout>
        <Routes>
          {/* Public route */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

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
        </Routes>
      </AppLayout>
    </BrowserRouter>
  );
}
