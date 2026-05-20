import React from 'react';
import { cn } from '../../utils/classNames';

const variants = {
  neutral: 'bg-[#172126] text-[#b8c8c7] border border-[#33474f]',
  success: 'bg-[#103827] text-[#77f0b2] border border-[#22694a]',
  warning: 'bg-[#332611] text-[#ffd77a] border border-[#6f531d]',
  danger: 'bg-[#3a1620] text-[#ffb5c2] border border-[#6a2b3a]',
  solid: 'bg-[#123323] text-[#8cf5bd] border border-[#26d07c]/55',
  info: 'bg-[#13243a] text-[#a9ceff] border border-[#315f99]'
};

export default function Badge({ children, className, variant = 'neutral' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide',
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
