import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Login from './pages/Login';
import Home from './pages/Home';
import Stock from './pages/Stock';

export default function App() {
  return (
    // Full-screen light gray background
    <div className="min-h-screen bg-gray-100">
      <BrowserRouter>
        {/* Your top nav bar */}
        <Navbar />

        {/* Main content container: centered, with padding */}
        <div className="container mx-auto px-4 py-6">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Home />} />
            <Route path="/stock/:symbol" element={<Stock />} />
          </Routes>
        </div>
      </BrowserRouter>
    </div>
  );
}
