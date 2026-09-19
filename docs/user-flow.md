# 사용자 흐름

## MVP 원칙

모든 연결과 job은 로그인 session에서 확정한 `userId`에 속한다. 팀, 공용 token, 다른 사용자의 결과 조회는 없다.

## 연결과 실행

1. 사용자가 OAuth/OIDC 공급자로 로그인한다.
2. Worker가 공급자 subject를 내부 `users.id`로 mapping하고 HttpOnly 세션을 발급한다.
3. 사용자가 본인의 Notion token, database ID, data source ID, property mapping을 등록한다.
4. 사용자가 본인의 1000.school credential을 등록한다.
5. 같은 사용자의 두 연결을 automation profile로 묶는다.
6. profile에서 `DRAFT_ONLY`를 기본 mode로 선택한다.
7. 대시보드에서 Notion `전송대기` page를 동기화한다.
8. Worker가 content hash 기반 job을 만들고 Queue에는 `userId`, `profileId`, `jobId`만 보낸다.
9. Queue consumer가 처리 직전에 user/profile/connection/credential 상태를 다시 확인한다.
10. Notion page와 block을 조회·검증한다.
11. target stage에 따라 1000.school 작성 → `organize` AI 제안 → `feedback` 텍스트 채점 → 최종 PUT 저장을 실행한다.
12. Worker 웹사이트 버튼, 예약 실행 또는 Notion webhook action은 로그인 세션과 별개로 같은 user-scoped Queue message를 생성한다.

## 실패와 재시도

- content가 job 생성 뒤 바뀌면 `CONTENT_CHANGED`로 종료한다.
- Notion 401/403은 사용자 연결만 `AUTH_REQUIRED`로 전환한다.
- 429, 일시적 5xx, network error만 제한적으로 재시도한다.
- 실패 job은 대시보드에서 실패 단계부터 재시도할 수 있다.
- 연결 해제 또는 profile 비활성화 시 보류 job은 취소한다.

## 보류된 자동화 단계

MVP에서는 사용자 승인에 따라 `organize`를 AI 제안, `feedback`을 텍스트 AI 채점, daily snippet POST/PUT을 작성·저장으로 매핑한다. 최종 저장은 Worker 웹사이트에서 확인하거나 `SAVE` webhook action으로 명시적으로 요청한다.
