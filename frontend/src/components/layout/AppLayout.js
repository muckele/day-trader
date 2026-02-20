import React from 'react';
import TopBar from './TopBar';
import SideNav from './SideNav';
import BottomNav from './BottomNav';
import { ToastProvider } from '../ui/Toast';

export default function AppLayout({ children }) {
  return (
    <ToastProvider>
      <div className="app-shell min-h-screen text-slate-100 font-sans">
        <TopBar />
        <div className="max-w-7xl mx-auto px-4 py-6 flex gap-6">
          <SideNav />
          <main className="flex-1 pb-24 lg:pb-8">{children}</main>
        </div>
        <footer className="text-xs text-emerald-100/45 text-center py-6 pb-24 lg:pb-6 tracking-wide">
          Educational purposes only. Not financial advice.
        </footer>
        <BottomNav />
      </div>
    </ToastProvider>
  );
}
