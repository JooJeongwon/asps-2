# ASPS

사용자별 Notion과 1000.school 연결을 격리해 daily snippet 작업을 실행하는 Cloudflare Workers 기반 서비스.

## 현재 상태

- 아키텍처 문서: [`docs/architecture.md`](docs/architecture.md)
- 계약 문서: [`docs/1000-school-api-contract.md`](docs/1000-school-api-contract.md), [`docs/notion-schema.md`](docs/notion-schema.md), [`docs/user-flow.md`](docs/user-flow.md)
- D1 초기 schema: [`migrations/0001_initial.sql`](migrations/0001_initial.sql)
- 구현된 endpoint: `GET /api/health`, `/api/me/*`, `/api/jobs*`, `POST /api/sync/notion`, `POST /api/webhooks/notion/:connectionId`
- 사용자 대시보드: 인증된 `/`에서 연결·profile·Notion 동기화·AI 제안·AI 채점·저장·job 상세·실패 재시도를 관리
- 1000.school client: [`src/services/thousand-school/client.ts`](src/services/thousand-school/client.ts)
- 1000.school 단계 매핑: `organize` → AI 제안, `feedback` → 텍스트 AI 채점, `POST/PUT daily-snippets` → 작성/저장
- 사용자 연결/profile API: `/api/me/*`
- job API: `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/action`, `/api/jobs/:id/retry`, `/api/jobs/:id/cancel`
- Notion sync API: `POST /api/sync/notion`
- Notion `작성완료` webhook이 최신 page를 확인해 `FULL_AUTO` 멱등 job을 Queue에 등록하고, `전송대기`도 legacy status로 지원
- Queue consumer: Notion 조회·content hash 검증 후 작성 → 제안 → 채점 → 저장을 target stage까지 실행
- user-scoped profile/job 조회·생성 거부 및 1000.school contract test 포함

인증은 Google OIDC 로그인과 HttpOnly 세션을 사용한다. OAuth 로그인은 대시보드 접근에만 필요하고, 실제 자동화는 사용자별 credential과 Queue가 서버에서 수행한다. Google의 공개 endpoint와 client ID는 `wrangler.jsonc`에 설정되어 있으며, 로컬에서는 `.env.example`을 사용한다.

## 시작

```bash
npm install
npm run typecheck
npm run dev
```

배포 전 `wrangler.jsonc`의 D1 `database_id`를 실제 값으로 바꾸고, 다음 secret을 등록한다.

- `CREDENTIAL_ENCRYPTION_KEY`
- `OAUTH_CLIENT_SECRET`
- `SESSION_SECRET`
- `WEBHOOK_SIGNING_SECRET`

Google Cloud Console에서 Web application client를 만들고 `OAUTH_REDIRECT_URI`와 정확히 같은 callback URL을 등록한다. `OAUTH_CLIENT_SECRET`은 Cloudflare Secret으로만 설정한다. client ID는 공개값이지만 client secret, session secret, credential encryption key는 저장소에 넣지 않는다. 브라우저 변경 요청에는 CSRF token을 자동으로 붙이며, Queue와 Notion webhook은 사용자 로그인 세션을 요구하지 않는다.

Notion webhook action에는 `x-asps-webhook-secret` custom header를 설정한다. 1000.school token은 `Authorization: Bearer` header로 전송하며, 실제 계정의 인증 방식이 다르면 adapter를 조정해야 한다.

자동 실행은 D1 migration 적용 후 Notion connection의 Webhooks 탭에서 `https://<worker-domain>/api/webhooks/notion/<notion-connection-id>` subscription을 만들고 `page.properties_updated`와 `page.content_updated`를 선택한다. 최초 verification 요청은 Worker가 처리하므로 token을 코드나 Secret에 복사하지 않는다. 이후 status를 `작성완료`로 바꾸면 Queue에서 작성 → AI 제안 → AI 채점 → 저장을 실행한다.
