import React from 'react';
import { cn } from '../../utils/classNames';

const variants = {
  neutral: 'bg-[#1a261f] text-emerald-100/80 border border-emerald-900/60',
  success: 'bg-[#0f3018] text-[#59ff84] border border-[#1f6b34]',
  warning: 'bg-[#2b2615] text-[#f9d281] border border-[#4b3f1e]',
  danger: 'bg-[#341a22] text-[#ff9db0] border border-[#5f2a38]',
  solid: 'bg-[#0f1b14] text-[#48ff79] border border-[#00c805]/55'
};

export default function Badge({ children, className, variant = 'neutral' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide backdrop-blur-sm',
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
