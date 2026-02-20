import React from 'react';
import TopBar from './TopBar';
import SideNav from './SideNav';
import BottomNav from './BottomNav';
import { ToastProvider } from '../ui/Toast';

export default function AppLayout({ children }) {
  return (
    <ToastProvider>
      <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans">
        <TopBar />
        <div className="max-w-6xl mx-auto px-4 py-6 flex gap-6">
          <SideNav />
          <main className="flex-1 pb-24 lg:pb-8">{children}</main>
        </div>
        <footer className="text-xs text-slate-400 text-center py-6 pb-24 lg:pb-6">
          Educational purposes only. Not financial advice.
        </footer>
        <BottomNav />
      </div>
    </ToastProvider>
  );
}
