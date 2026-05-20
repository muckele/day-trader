import React from 'react';
import { cn } from '../../utils/classNames';

const variants = {
  primary: 'bg-[#26d07c] text-[#06110d] hover:bg-[#35e08d] border border-[#52e8a1]/40 shadow-[0_10px_24px_rgba(38,208,124,0.16)]',
  secondary: 'bg-[#172126] text-[#edf5f4] hover:bg-[#1d2a30] border border-[#33474f]',
  ghost: 'bg-transparent text-[#b8c8c7] hover:bg-[#172126] hover:text-[#edf5f4] border border-transparent',
  danger: 'bg-[#3a1620] text-[#ffb5c2] hover:bg-[#4a1d2a] border border-[#6a2b3a]',
  warning: 'bg-[#332611] text-[#ffd77a] hover:bg-[#443315] border border-[#6f531d]'
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
        'rh-btn inline-flex min-h-[2.25rem] items-center justify-center rounded-lg font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#26d07c]/35 disabled:opacity-60 disabled:cursor-not-allowed',
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
