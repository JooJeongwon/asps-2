# 사용자 흐름

## MVP 원칙

모든 연결과 job은 로그인 session에서 확정한 `userId`에 속한다. 팀, 공용 token, 다른 사용자의 결과 조회는 없다.

## 연결과 실행

1. 사용자가 Cloudflare Access로 로그인한다.
2. Worker가 Access JWT의 불변 `sub`를 내부 `users.id`로 mapping한다.
3. 사용자가 본인의 Notion token, database ID, data source ID, property mapping을 등록한다.
4. 사용자가 본인의 1000.school credential을 등록한다.
5. 같은 사용자의 두 연결을 automation profile로 묶는다.
6. profile에서 `DRAFT_ONLY`를 기본 mode로 선택한다.
7. 대시보드에서 Notion `전송대기` page를 동기화한다.
8. Worker가 content hash 기반 job을 만들고 Queue에는 `userId`, `profileId`, `jobId`만 보낸다.
9. Queue consumer가 처리 직전에 user/profile/connection/credential 상태를 다시 확인한다.
10. Notion page와 block을 조회·검증한 뒤 현재 구현에서는 job을 `FETCHED`로 전이한다.

## 실패와 재시도

- content가 job 생성 뒤 바뀌면 `CONTENT_CHANGED`로 종료한다.
- Notion 401/403은 사용자 연결만 `AUTH_REQUIRED`로 전환한다.
- 429, 일시적 5xx, network error만 제한적으로 재시도한다.
- 실패 job은 대시보드에서 실패 단계부터 재시도할 수 있다.
- 연결 해제 또는 profile 비활성화 시 보류 job은 취소한다.

## 보류된 자동화 단계

현재 API snapshot에는 AI 제안, AI 채점, 최종 저장 계약이 없다. 해당 계약이 확인되기 전에는 browser automation이나 임의 endpoint 매핑을 사용하지 않는다. 계약 확인 후에도 기본 mode는 최종 저장 전 사용자 확인으로 유지한다.
