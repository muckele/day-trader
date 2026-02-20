import React from 'react';
import { cn } from '../../utils/classNames';

export default function Skeleton({ className }) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-slate-200/80 dark:bg-slate-800/70', className)}
    />
  );
}
