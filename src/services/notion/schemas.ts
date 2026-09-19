import { z } from "zod";

export const NotionPageSchema = z
  .object({
    object: z.string().optional(),
    id: z.string(),
    last_edited_time: z.string().optional(),
    archived: z.boolean().optional(),
    in_trash: z.boolean().optional(),
    properties: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const NotionBlockSchema = z
  .object({
    object: z.string().optional(),
    id: z.string(),
    type: z.string(),
    has_children: z.boolean().optional(),
  })
  .passthrough();

export const NotionListSchema = z
  .object({
    object: z.string().optional(),
    results: z.array(z.unknown()),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean(),
  })
  .passthrough();

export const NotionBlockListSchema = NotionListSchema.extend({
  results: z.array(NotionBlockSchema),
});

export const NotionPageListSchema = NotionListSchema.extend({
  results: z.array(NotionPageSchema),
});

export type NotionPage = z.infer<typeof NotionPageSchema>;
export type NotionBlock = z.infer<typeof NotionBlockSchema> & { children?: NotionBlock[] };
export type NotionQueryBody = Record<string, unknown>;
