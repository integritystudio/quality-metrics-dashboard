import { z } from 'zod';
import type { ReactNode } from 'react';
import type { WorkflowGraph } from '../types/workflow-graph.js';

// ---------------------------------------------------------------------------
// Link (wouter) component props
// ---------------------------------------------------------------------------

export const LinkPropsSchema = z.object({
  href: z.string(),
  children: z.instanceof(Object), // ReactNode
});

export type LinkProps = z.infer<typeof LinkPropsSchema> & {
  children: ReactNode;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// WorkflowGraphView component props
// ---------------------------------------------------------------------------

export const WorkflowGraphViewPropsSchema = z.object({
  graph: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      label: z.string(),
    })),
    edges: z.array(z.unknown()).optional(),
    rootNodeId: z.string().nullable().optional(),
    workflowShape: z.string().optional(),
  }),
  onNodeClick: z.custom<(nodeId: string) => void>().optional(),
});

export type WorkflowGraphViewProps = {
  graph: WorkflowGraph;
  onNodeClick?: (nodeId: string) => void;
};

// ---------------------------------------------------------------------------
// DetailPageHeader component props
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PageShell component props
// ---------------------------------------------------------------------------

export const PageShellPropsSchema = z.object({
  isLoading: z.boolean(),
  error: z.object({
    message: z.string(),
  }).nullable(),
  children: z.instanceof(Object), // ReactNode
});

export type PageShellProps = {
  isLoading: boolean;
  error: { message: string } | null;
  children: ReactNode;
};
