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

export type WithRepo<T> = T & { repo?: string }

export function withRepo<S extends z.ZodObject<z.ZodRawShape>>(
  schema: S,
  repos: readonly string[],
): z.ZodType<WithRepo<z.infer<S>>> {
  const [first, ...rest] = repos
  const extended =
    first === undefined
      ? schema
      : schema.extend({
          repo: z
            .enum([first, ...rest])
            .optional()
            .describe('Related repository to read instead of the one under review'),
        })
  return extended as unknown as z.ZodType<WithRepo<z.infer<S>>>
}

export function qualified(repo: string | undefined, path: string): string {
  return repo === undefined ? path : `${repo}:${path}`
}
