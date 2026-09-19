export const authStatusFixture = {
  authenticated: true,
  user: {
    name: "Fixture User",
    email: "fixture@example.invalid",
    picture: "",
    email_verified: true,
  },
};

export const dailySnippetListFixture = {
  items: [{
    id: 101,
    user_id: 7,
    date: "2026-09-19",
    content: "sanitized fixture content",
    feedback: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    comments_count: 0,
    editable: true,
  }],
  total: 1,
  limit: 50,
  offset: 0,
};

export const apiTokenFixture = {
  id: 11,
  description: "sanitized test token",
  created_at: "2026-09-19T00:00:00.000Z",
  last_used_at: null,
};
