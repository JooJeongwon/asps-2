# 1000.school API 계약

## 기준

- 공식 문서: <https://api.1000.school/docs#/> 
- 저장소 계약 snapshot: `openapi.json` (`FastAPI 0.1.0`)
- 이 문서는 snapshot에서 확인된 내용과 아직 확인하지 못한 내용을 분리한다.

## 인증

현재 `openapi.json`에는 `securitySchemes`가 선언되어 있지 않다. 따라서 인증 header 이름, token 형식, cookie/CSRF 사용 여부를 코드에서 추측하지 않는다. `ThousandSchoolClient`는 호출자가 주입한 `headers`만 사용한다.

실제 사용자 credential을 연결하기 전 확인할 것:

1. API token을 어떤 header에 넣는지
2. token 발급·폐기 API와 daily snippet API의 인증 방식이 같은지
3. 401/403 응답 body와 rate limit header
4. write timeout 뒤 성공 여부를 조회할 수 있는지

## 확인된 endpoint

| Method | Path | Request | Response | 현재 client |
| --- | --- | --- | --- | --- |
| GET | `/auth/me` | 없음 | `AuthStatusResponse` | 구현 |
| GET | `/auth/tokens` | 없음 | `ApiTokenResponse[]` | 구현 |
| POST | `/auth/tokens` | `{ description: string }` | `NewApiTokenResponse` | 구현 |
| DELETE | `/auth/tokens/{token_id}` | 없음 | 빈 응답 | 구현 |
| GET | `/daily-snippets` | query pagination/date/id/q/scope | `DailySnippetListResponse` | 구현 |
| GET | `/daily-snippets/{snippet_id}` | 없음 | `DailySnippetResponse` | 구현 |
| POST | `/daily-snippets` | `{ content: string }` | `DailySnippetResponse` | 구현 |
| PUT | `/daily-snippets/{snippet_id}` | `{ content: string }` | `DailySnippetResponse` | 구현 |
| DELETE | `/daily-snippets/{snippet_id}` | 없음 | 빈 응답 | 구현 |
| POST | `/daily-snippets/organize` | `{ content: string }` | `{ date, organized_content }` | 구현 |
| GET | `/daily-snippets/feedback` | optional `stream` | `{ date, feedback }` | 구현 |
| GET | `/daily-snippets/page-data` | optional `id`, `date` | `DailySnippetPageDataResponse` | 구현 |

`listDailySnippets`는 다른 사용자 조회를 막기 위해 `scope=own`을 항상 고정한다.

## 오류·재시도

현재 adapter의 상태 변환은 다음과 같다.

| HTTP/상태 | 내부 code | 자동 재시도 |
| --- | --- | --- |
| 401, 403 | `AUTH_REQUIRED` | 아니오 |
| 429 | `RATE_LIMITED` | 예 |
| 5xx | `UPSTREAM_ERROR` | 예 |
| network/timeout | `NETWORK_ERROR` | 예 |
| JSON/schema 불일치 | `INVALID_RESPONSE` | 아니오 |

기본 timeout은 10초다. API가 제공하는 `Retry-After` 해석은 아직 adapter에 없고, Queue workflow를 붙일 때 추가해야 한다.

## 자동화 단계와 차단 사항

OpenAPI에서 다음 endpoint는 확인되지 않았다.

- AI 제안 전용 endpoint
- AI 점수 전용 endpoint
- 최종 저장 전용 endpoint
- write timeout 뒤 idempotency 조회 endpoint

`organize`는 `organized_content`를 반환하지만 AI 제안으로, `feedback`은 날짜별 feedback으로 보이지만 AI 점수로 임의 매핑하지 않는다. 따라서 작성 → AI 제안 → AI 채점 → 저장 workflow와 실제 credential 기반 write는 공식 계약 또는 별도 승인된 계약이 생길 때까지 보류한다.

## Sanitized contract test

`test/thousand-school-client.test.ts`는 실제 token이나 외부 write 없이 다음을 검증한다.

- `scope=own` 강제
- request method, body, `Idempotency-Key`
- response schema 검증
- 401, malformed response 변환
