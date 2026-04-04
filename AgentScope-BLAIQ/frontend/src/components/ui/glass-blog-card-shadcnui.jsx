import React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import { BookOpen, Clock } from 'lucide-react';

const defaultPost = {
  title: 'The Future of UI Design',
  excerpt:
    'Exploring the latest trends in glassmorphism, 3D elements, and micro-interactions.',
  image:
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&q=80',
  author: {
    name: 'Moumen Soliman',
    avatar: 'https://github.com/shadcn.png',
  },
  date: 'Dec 2, 2025',
  readTime: '5 min read',
  tags: ['Design', 'UI/UX'],
};

export function GlassBlogCard({
  title = defaultPost.title,
  excerpt = defaultPost.excerpt,
  image = defaultPost.image,
  author = defaultPost.author,
  date = defaultPost.date,
  readTime = defaultPost.readTime,
  tags = defaultPost.tags,
  className,
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn('w-full max-w-[400px]', className)}
    >
      <Card className="group relative h-full overflow-hidden rounded-[2rem] border-[rgba(0,0,0,0.08)] bg-white/30 backdrop-blur-md transition-all duration-300 hover:border-[#FF5C4B]/40 hover:shadow-[0_28px_70px_rgba(255,92,75,0.12)]">
        <div className="relative aspect-[16/9] overflow-hidden">
          <motion.img
            src={image}
            alt={title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#0B0B0B]/70 via-[#0B0B0B]/10 to-transparent opacity-70 transition-opacity duration-300 group-hover:opacity-45" />

          <div className="absolute bottom-3 left-3 flex gap-2">
            {tags?.map((tag, index) => (
              <Badge
                key={index}
                variant="secondary"
                className="bg-white/45 backdrop-blur-sm hover:bg-white/75"
              >
                {tag}
              </Badge>
            ))}
          </div>

          <div className="absolute inset-0 flex items-center justify-center bg-[#0B0B0B]/10 backdrop-blur-[2px] opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="flex items-center gap-2 rounded-full bg-[#FF5C4B] px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-[#FF5C4B]/25"
            >
              <BookOpen className="h-4 w-4" />
              View Agent
            </motion.button>
          </div>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <div className="space-y-2">
            <h3 className="text-xl font-semibold leading-tight tracking-tight text-[#111827] transition-colors group-hover:text-[#FF5C4B]">
              {title}
            </h3>
            <p className="line-clamp-2 text-sm text-[#6b7280]">
              {excerpt}
            </p>
          </div>

          <div className="flex items-center justify-between border-t border-[rgba(0,0,0,0.08)] pt-4">
            <div className="flex items-center gap-2">
              <Avatar className="h-8 w-8 border border-[rgba(0,0,0,0.08)]">
                <AvatarImage src={author?.avatar} alt={author?.name} />
                <AvatarFallback>{author?.name?.[0] || 'A'}</AvatarFallback>
              </Avatar>
              <div className="flex flex-col text-xs">
                <span className="font-medium text-[#111827]">
                  {author?.name}
                </span>
                <span className="text-[#6b7280]">{date}</span>
              </div>
            </div>

            <div className="flex items-center gap-1 text-xs text-[#6b7280]">
              <Clock className="h-3 w-3" />
              <span>{readTime}</span>
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
