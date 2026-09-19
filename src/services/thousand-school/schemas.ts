import { z } from "zod";

const TeamMemberSummarySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    email: z.string(),
    picture: z.string().nullable(),
  })
  .passthrough();

const UserResponseSchema = z
  .object({
    name: z.string(),
    email: z.string(),
    picture: z.string(),
    email_verified: z.boolean(),
    roles: z.array(z.string()).optional(),
    league_type: z.enum(["undergrad", "semester", "none"]).optional(),
    is_provisional: z.boolean().optional(),
    has_required_consents: z.boolean().optional(),
    consents: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const AuthStatusResponseSchema = z.object({
  authenticated: z.boolean(),
  user: UserResponseSchema.nullable().optional(),
});

export const ApiTokenResponseSchema = z.object({
  id: z.number().int(),
  description: z.string().nullable().optional(),
  created_at: z.string(),
  last_used_at: z.string().nullable().optional(),
});

export const NewApiTokenResponseSchema = ApiTokenResponseSchema.extend({
  token: z.string().nullable().optional(),
});

export const DailySnippetResponseSchema = z
  .object({
    id: z.number().int(),
    user_id: z.number().int(),
    user: TeamMemberSummarySchema.nullable().optional(),
    date: z.string(),
    content: z.string(),
    feedback: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    comments_count: z.number().int().optional(),
    editable: z.boolean().optional(),
  })
  .passthrough();

export const DailySnippetListResponseSchema = z.object({
  items: z.array(DailySnippetResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export const DailySnippetFeedbackResponseSchema = z.object({
  date: z.string(),
  feedback: z.string().nullable().optional(),
});

export const DailySnippetOrganizeResponseSchema = z.object({
  date: z.string(),
  organized_content: z.string(),
});

export const DailySnippetPageDataResponseSchema = z.object({
  snippet: DailySnippetResponseSchema.nullable().optional(),
  read_only: z.boolean(),
  prev_id: z.number().int().nullable().optional(),
  next_id: z.number().int().nullable().optional(),
});

export const CreateTokenRequestSchema = z.object({ description: z.string() });
export const DailySnippetContentSchema = z.object({ content: z.string() });

export type AuthStatusResponse = z.infer<typeof AuthStatusResponseSchema>;
export type ApiTokenResponse = z.infer<typeof ApiTokenResponseSchema>;
export type NewApiTokenResponse = z.infer<typeof NewApiTokenResponseSchema>;
export type DailySnippetResponse = z.infer<typeof DailySnippetResponseSchema>;
export type DailySnippetListResponse = z.infer<typeof DailySnippetListResponseSchema>;
export type DailySnippetFeedbackResponse = z.infer<typeof DailySnippetFeedbackResponseSchema>;
export type DailySnippetOrganizeResponse = z.infer<typeof DailySnippetOrganizeResponseSchema>;
export type DailySnippetPageDataResponse = z.infer<typeof DailySnippetPageDataResponseSchema>;
