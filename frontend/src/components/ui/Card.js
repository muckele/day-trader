import React from 'react';
import { cn } from '../../utils/classNames';

const variants = {
  default: 'bg-[#111a15]/90 border border-emerald-900/60 shadow-[0_0_0_1px_rgba(0,200,5,0.08),0_14px_28px_rgba(0,0,0,0.45)]',
  elevated: 'bg-[#121c16] border border-emerald-800/70 shadow-[0_0_0_1px_rgba(0,200,5,0.18),0_18px_36px_rgba(0,0,0,0.5)]',
  compact: 'bg-[#101913]/85 border border-emerald-900/55'
};

export default function Card({ children, className, variant = 'default', ...props }) {
  return (
    <div className={cn('rh-card rounded-2xl', variants[variant], className)} {...props}>
      {children}
    </div>
  );
}
