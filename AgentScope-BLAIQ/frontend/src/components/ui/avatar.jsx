import React from 'react';
import { cn } from '@/lib/utils';

export function Avatar({ className, children, ...props }) {
  return (
    <div
      className={cn('relative inline-flex h-10 w-10 shrink-0 overflow-hidden rounded-full', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function AvatarImage({ className, src, alt = '', ...props }) {
  if (!src) return null;
  return <img src={src} alt={alt} className={cn('h-full w-full object-cover', className)} {...props} />;
}

export function AvatarFallback({ className, children, ...props }) {
  return (
    <div
      className={cn(
        'flex h-full w-full items-center justify-center bg-[#E4DED2] text-sm font-semibold text-[#0B0B0B]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
