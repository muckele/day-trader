import React from 'react';
import { cn } from '../../utils/classNames';

const variants = {
  default: 'bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm',
  elevated: 'bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-lg',
  compact: 'bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800'
};

export default function Card({ children, className, variant = 'default', ...props }) {
  return (
    <div className={cn('rounded-2xl', variants[variant], className)} {...props}>
      {children}
    </div>
  );
}
