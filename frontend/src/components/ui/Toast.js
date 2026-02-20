import React, { useEffect, useState } from 'react';
import { cn } from '../../utils/classNames';

const typeStyles = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
  warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  info: 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const handler = event => {
      const detail = event.detail || {};
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setToasts(prev => [...prev, { id, ...detail }]);

      const timeout = detail.duration ?? 4000;
      if (timeout !== null) {
        setTimeout(() => {
          setToasts(prev => prev.filter(item => item.id !== id));
        }, timeout);
      }
    };

    window.addEventListener('app:toast', handler);
    return () => window.removeEventListener('app:toast', handler);
  }, []);

  const dismiss = id => {
    setToasts(prev => prev.filter(item => item.id !== id));
  };

  return (
    <>
      {children}
      <div className="fixed top-4 right-4 z-50 flex w-80 flex-col gap-3">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={cn(
              'rounded-xl border p-4 shadow-lg backdrop-blur-sm',
              typeStyles[toast.type || 'info']
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                {toast.title && (
                  <p className="text-sm font-semibold">{toast.title}</p>
                )}
                <p className="text-sm">{toast.message}</p>
              </div>
              <button
                className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
                onClick={() => dismiss(toast.id)}
              >
                Close
              </button>
            </div>
            {toast.action && (
              <button
                className="mt-3 text-xs font-semibold text-slate-700 underline underline-offset-2 dark:text-slate-200"
                onClick={() => {
                  toast.action.onClick?.();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
