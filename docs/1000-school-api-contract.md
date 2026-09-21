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
| network/timeout | `NETWORK_ERROR` | 일반 조회만 예; 결과를 조회할 수 없는 AI 요청은 아니오 |
| JSON/schema 불일치 | `INVALID_RESPONSE` | 아니오 |

기본 timeout은 SSE 완료 시간을 고려해 60초다. `Retry-After`가 초 또는 HTTP-date로 오면 adapter가 초 단위로 보존하며, Queue는 최대 300초로 제한해 사용한다. 헤더가 없으면 exponential backoff와 jitter를 사용한다.

SSE AI 요청이 연결 중단이나 5xx로 끝나면 생성 완료 여부를 확인할 API가 없으므로 `AI_RESULT_AMBIGUOUS`로 남기고 자동·일반 재시도를 막는다. 사용자가 1000.school 결과를 확인한 뒤 새 job을 시작해야 한다.

## 자동화 단계와 승인된 MVP 매핑

OpenAPI에서 다음 endpoint는 확인되지 않았다.

- AI 제안 전용 endpoint
- AI 점수 전용 endpoint
- 최종 저장 전용 endpoint
- write timeout 뒤 idempotency 조회 endpoint

사용자 승인에 따라 MVP에서는 다음처럼 매핑한다.

| 내부 단계 | API | 저장 결과 |
| --- | --- | --- |
| 작성 | `POST /daily-snippets` 또는 기존 ID에 `PUT /daily-snippets/{snippet_id}` | remote snippet ID |
| AI 제안 | `POST /daily-snippets/organize?stream=1` | SSE `organized_content`를 즉시 draft에 적용하고 Notion suggestion property에 기록 |
| AI 채점 | `GET /daily-snippets/feedback?stream=1` | 적용된 제안에 대한 SSE `feedback`을 Notion score/feedback property에 기록 |
| 저장 | `GET`, 필요 시 `PUT /daily-snippets/{snippet_id}` | 자동 적용된 AI 제안 내용을 확인하고 중복 PUT 방지 |

`feedback`은 숫자 점수가 아니라 텍스트이므로, 숫자 점수가 필요한 사용자는 별도 변환 계약이 필요하다. `GET /daily-snippets/feedback`은 snippet ID를 받지 않고 인증된 사용자의 현재 daily snippet을 대상으로 하므로, 요청 날짜가 job의 `targetDate`와 같은지 검증한다.

Daily snippet 생성·수정과 AI 요청에는 날짜 입력이 없으므로 `targetDate`가 `Asia/Seoul`의 오늘과 다르면 외부 요청 전에 중단한다.

이 매핑은 공식 API의 명시적 단계명이 아닌 사용자 승인에 따른 MVP 해석이다. 실제 운영에서 의미가 달라지면 adapter 계약을 분리해 교체한다.

## Sanitized contract test

`test/thousand-school-client.test.ts`는 실제 token이나 외부 write 없이 다음을 검증한다.

- `scope=own` 강제
- request method, body, `Idempotency-Key`
- response schema 검증
- 401, malformed response 변환
