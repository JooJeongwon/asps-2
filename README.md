# ASPS

사용자별 Notion과 1000.school 연결을 격리해 daily snippet 작업을 실행하는 Cloudflare Workers 기반 서비스.

## 현재 상태

- 아키텍처 문서: [`docs/architecture.md`](docs/architecture.md)
- 계약 문서: [`docs/1000-school-api-contract.md`](docs/1000-school-api-contract.md), [`docs/notion-schema.md`](docs/notion-schema.md), [`docs/user-flow.md`](docs/user-flow.md)
- D1 초기 schema: [`migrations/0001_initial.sql`](migrations/0001_initial.sql)
- 구현된 endpoint: `GET /api/health`, `/api/me/*`, `/api/jobs*`, `POST /api/sync/notion`
- 사용자 대시보드: 인증된 `/`에서 연결·profile·Notion 동기화·job 상세·실패 재시도를 관리
- 1000.school client: [`src/services/thousand-school/client.ts`](src/services/thousand-school/client.ts)
- 1000.school AI 채점/최종 저장 endpoint: OpenAPI에 없어 미구현
- 사용자 연결/profile API: `/api/me/*`
- job API: `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/retry`, `/api/jobs/:id/cancel`
- Notion sync API: `POST /api/sync/notion`
- Notion sync가 `전송대기` page를 서버에서 해시해 멱등 job을 Queue에 등록
- Queue consumer: Notion 조회 및 content hash 검증 후 `FETCHED` 전이
- user-scoped profile/job 조회·생성 거부 및 1000.school contract test 포함

인증은 Cloudflare Access JWT를 사용한다. 로컬/배포 환경에서는 `.env.example`의 `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL`와 Cloudflare Secret `CREDENTIAL_ENCRYPTION_KEY`를 설정해야 한다.

## 시작

```bash
npm install
npm run typecheck
npm run dev
```

배포 전 `wrangler.jsonc`의 D1 `database_id`를 실제 값으로 바꾸고, 다음 secret을 등록한다.

- `CREDENTIAL_ENCRYPTION_KEY`
- `SESSION_SECRET`
- `WEBHOOK_SIGNING_SECRET`

실제 외부 계정 연결이나 저장 기능은 아직 활성화하지 않는다. `openapi.json`에 없는 1000.school AI/저장 계약은 구현하지 않는다.
