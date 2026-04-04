import React from 'react';
import { cn } from '@/lib/utils';

const variants = {
  default: 'bg-[#0B0B0B] text-white border-transparent',
  secondary: 'bg-white/50 text-[#18181b] border-[rgba(0,0,0,0.08)]',
  outline: 'bg-transparent text-[#18181b] border-[rgba(0,0,0,0.1)]',
};

export function Badge({ className, variant = 'default', children, ...props }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.02em]',
        variants[variant] || variants.default,
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
