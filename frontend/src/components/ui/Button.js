import React from 'react';
import { cn } from '../../utils/classNames';

const variants = {
  primary: 'rh-btn-primary bg-[#00c805] text-[#031107] hover:bg-[#0de843] shadow-[0_0_0_1px_rgba(0,200,5,0.28)]',
  secondary: 'bg-[#17231c] text-emerald-50 hover:bg-[#1d2c23] border border-emerald-900/60',
  ghost: 'bg-transparent text-emerald-100/80 hover:bg-[#1a261f] hover:text-emerald-200',
  danger: 'bg-[#3a171f] text-[#ff9fb0] hover:bg-[#4b1d28] border border-[#5d2734]'
};

const sizes = {
  sm: 'text-xs px-3 py-1.5',
  md: 'text-sm px-4 py-2',
  lg: 'text-base px-5 py-2.5'
};

export default function Button({
  children,
  className,
  variant = 'primary',
  size = 'md',
  type = 'button',
  ...props
}) {
  return (
    <button
      type={type}
      className={cn(
        'rh-btn inline-flex items-center justify-center rounded-lg font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00c805]/40 disabled:opacity-60 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
