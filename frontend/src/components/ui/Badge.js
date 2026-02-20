import React from 'react';
import { cn } from '../../utils/classNames';

const variants = {
  neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  danger: 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  solid: 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
};

export default function Badge({ children, className, variant = 'neutral' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide',
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
