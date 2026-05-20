import React from 'react';
import { cn } from '../../utils/classNames';

const variants = {
  default: 'bg-[#11181b]/95 border border-[#26363c] shadow-[0_18px_42px_rgba(0,0,0,0.32)]',
  elevated: 'bg-[#141d21] border border-[#33505a] shadow-[0_22px_52px_rgba(0,0,0,0.42)]',
  compact: 'bg-[#10171a]/92 border border-[#243137]',
  warning: 'bg-[#1b1710]/95 border border-[#5f4a1d] shadow-[0_18px_42px_rgba(0,0,0,0.28)]',
  danger: 'bg-[#1b1115]/95 border border-[#5e2634] shadow-[0_18px_42px_rgba(0,0,0,0.32)]'
};

export default function Card({ children, className, variant = 'default', ...props }) {
  return (
    <div className={cn('rh-card rounded-lg', variants[variant], className)} {...props}>
      {children}
    </div>
  );
}
