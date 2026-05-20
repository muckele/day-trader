import React, { useEffect, useState } from 'react';
import { cn } from '../../utils/classNames';

const typeStyles = {
  success: 'border-[#22694a] bg-[#103827] text-[#77f0b2]',
  error: 'border-[#6a2b3a] bg-[#30111a] text-[#ffb5c2]',
  warning: 'border-[#6f531d] bg-[#332611] text-[#ffd77a]',
  info: 'border-[#33474f] bg-[#172126] text-[#d9e5e4]'
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
              'rounded-lg border p-4 shadow-lg backdrop-blur-sm',
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
                className="text-xs text-[#a9b8b8] hover:text-[#edf5f4]"
                onClick={() => dismiss(toast.id)}
              >
                Close
              </button>
            </div>
            {toast.action && (
              <button
                className="mt-3 text-xs font-semibold text-[#8cf5bd] underline underline-offset-2"
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
