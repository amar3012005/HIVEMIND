import React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, children, ...props }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white/75 shadow-[0_24px_70px_rgba(0,0,0,0.08)]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
