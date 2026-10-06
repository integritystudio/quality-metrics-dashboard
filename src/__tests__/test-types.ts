import { z } from 'zod';
import type { ReactNode } from 'react';

// Link (wouter) component props

export const LinkPropsSchema = z.object({
  href: z.string(),
  children: z.instanceof(Object), // ReactNode
});

export type LinkProps = z.infer<typeof LinkPropsSchema> & {
  children: ReactNode;
  [key: string]: unknown;
};


export const DetailPageHeaderPropsSchema = z.object({
  title: z.string(),
  id: z.string().optional(),
  children: z.instanceof(Object).optional(), // ReactNode
});

export type DetailPageHeaderProps = {
  title: string;
  id?: string;
  children?: ReactNode;
};


export const PageShellPropsSchema = z.object({
  isLoading: z.boolean(),
  error: z.object({
    message: z.string(),
  }).nullable(),
  backHref: z.string().optional(),
  backLabel: z.string().optional(),
  children: z.instanceof(Object), // ReactNode
});

export type PageShellProps = {
  isLoading: boolean;
  error: { message: string } | null;
  backHref?: string;
  backLabel?: string;
  children: ReactNode;
};
