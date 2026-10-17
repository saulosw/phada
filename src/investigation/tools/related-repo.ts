import { z } from 'zod'
import type { RepositoryGraph } from '../../graph/types.js'
import type { Checkout } from '../../repository/checkout.js'

export interface RelatedCheckout {
  repo: string
  checkout: Checkout
  graph?: RepositoryGraph
}

export const RELATED_NOTE =
  ' With repo, it reads a related repository instead, at the head of its default branch.'

export function withRepo<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  repos: readonly string[],
): z.ZodType {
  const [first, ...rest] = repos
  if (first === undefined) return schema
  return schema.extend({
    repo: z
      .enum([first, ...rest])
      .optional()
      .describe('Related repository to read instead of the one under review'),
  })
}

export function qualified(repo: string | undefined, path: string): string {
  return repo === undefined ? path : `${repo}:${path}`
}
