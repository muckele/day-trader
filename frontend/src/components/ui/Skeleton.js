import React from 'react';
import { cn } from '../../utils/classNames';

export default function Skeleton({ className }) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-[#1d2a30]/90', className)}
    />
  );
}
