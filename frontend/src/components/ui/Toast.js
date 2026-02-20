import React, { useEffect, useState } from 'react';
import { cn } from '../../utils/classNames';

const typeStyles = {
  success: 'border-[#1f6b34] bg-[#0f3018] text-[#64ff8d]',
  error: 'border-[#5f2a38] bg-[#30111a] text-[#ff9db0]',
  warning: 'border-[#4b3f1e] bg-[#2b2615] text-[#f9d281]',
  info: 'border-emerald-900/60 bg-[#131c17] text-emerald-100/85'
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
                className="text-xs text-emerald-100/55 hover:text-emerald-200"
                onClick={() => dismiss(toast.id)}
              >
                Close
              </button>
            </div>
            {toast.action && (
              <button
                className="mt-3 text-xs font-semibold text-emerald-200 underline underline-offset-2"
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
