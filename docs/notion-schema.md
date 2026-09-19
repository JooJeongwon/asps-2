# Notion database schema

## 연결 설정

사용자별 `notion_connection`에 다음 값을 저장한다.

- `database_id`: 사용자가 연결한 database container ID
- `data_source_id`: query 대상 data source ID
- `property_mapping_json`: 사용자의 실제 property 이름 mapping
- 암호화된 Integration token

권장 mapping은 다음과 같다.

```json
{
  "title": "제목",
  "date": "날짜",
  "status": "상태",
  "jobId": "ASPS Job ID",
  "remoteId": "1000school ID",
  "suggestion": "AI 제안",
  "score": "AI 피드백",
  "lastError": "마지막 오류"
}
```

실제 property 이름은 사용자마다 다를 수 있으므로 기본값을 계약으로 강제하지 않는다.

## page property

| Mapping key | 권장 Notion type | 용도 | 현재 구현 |
| --- | --- | --- | --- |
| `title` | `title` | 초안 식별용 제목 | mapping 보관 |
| `date` | `date` | job `targetDate` | 읽기 |
| `status` | `select` 또는 `status` | `작성중`에서 `작성완료` 전환 감지 | 읽기/쓰기 |
| `jobId` | `rich_text` | ASPS job ID | sync 시 기록 |
| `remoteId` | `rich_text` | 1000.school ID | 작성 단계에서 기록 |
| `suggestion` | `rich_text` | `organize` 결과 | AI 제안 단계에서 기록 |
| `score` | `rich_text` 또는 숫자로 변환 가능한 `number` | `feedback` 결과 | AI 채점 단계에서 기록 |
| `lastError` | `rich_text` | 안전한 오류 코드 | 실패 시 기록 |

상태 옵션은 `작성중`, `작성완료`, `처리중`, `완료`, `오류`를 사용한다. `작성중` page는 자동 실행하지 않으며, `작성완료`로 바꾸면 자동 실행 대상이 된다. 해당 page의 child block을 순서대로 읽어 plain text와 SHA-256 content hash를 만든다. 지원하지 않는 block은 `[Unsupported block: ...]` placeholder와 warning으로 남긴다.

## 처리 흐름

1. 활성 profile의 data source를 pagination으로 조회한다.
2. 각 page의 child block을 pagination하고 tree를 hydrate한다.
3. `date`, `status`, content를 변환한다.
4. status가 `작성완료`이고 date/content가 유효하면 `FULL_AUTO` job을 만든다.
5. `userId + profileId + notionPageId + targetDate + contentHash + mode`로 중복을 막는다.

## 작성완료 자동 실행

Notion connection 설정의 Webhooks 탭에서 다음 URL로 subscription을 만들고 `page.properties_updated`, `page.content_updated` 이벤트를 선택한다.

```text
https://<worker-domain>/api/webhooks/notion/<notion-connection-id>
```

Notion이 보내는 최초 `verification_token`은 Worker가 암호화해 해당 connection에 저장한다. 이후 이벤트가 오면 Worker가 최신 page와 block을 다시 조회하고, 현재 status가 `작성완료`인 page만 자동 실행 대상으로 처리한다. 작성 중에는 `작성중`을 유지하고 마지막에 `작성완료`로 바꾸므로, 이 전환이 자동 실행의 트리거가 된다. Queue consumer는 같은 사용자의 1000.school credential로 작성 → AI 제안 → AI 채점 → 저장을 순서대로 실행한다.

Notion에서 status property에 위 다섯 가지 옵션을 만든 뒤, 작성 중에는 `작성중`을 유지하고 제출할 때 `작성완료`로 변경한다. Worker는 로그인 세션 없이 Webhook과 Queue로 나머지 단계를 처리한다.

Notion webhook은 변경된 본문을 직접 보내지 않고 page ID만 보내므로, event subscription을 검증한 뒤 최신 page를 조회한다. Notion의 event 전달은 보통 1분 이내지만 최대 5분이 걸릴 수 있다.

## 웹훅 버튼

Notion 버튼 또는 database automation의 `Send webhook`에 다음 POST URL을 등록한다.

```text
https://<worker-domain>/api/webhooks/notion/<notion-connection-id>
```

custom header `x-asps-webhook-secret`에는 Cloudflare Secret `WEBHOOK_SIGNING_SECRET` 값을 넣고, body에는 다음 중 하나를 보낸다.

```json
{"action":"SUGGEST","jobId":"<job-id>"}
```

`action`은 `SUGGEST`, `SCORE`, `SAVE` 중 하나다. sync 시 Worker가 `jobId` property에 작업 ID를 기록하므로, 버튼 또는 database automation은 해당 property 값을 body에 넣는다. Worker는 connection ID와 job 소유자를 함께 확인한 뒤 Queue에 ID만 넣는다.

Notion database의 실제 property type과 샘플 page는 사용자가 연결할 workspace에서 한 번 수동 확인해야 한다. `score`를 텍스트 feedback으로 저장하려면 rich text property를 사용한다.
