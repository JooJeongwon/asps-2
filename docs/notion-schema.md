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
| `status` | `select` 또는 `status` | 전송 대상 판별 | 읽기 |
| `jobId` | `rich_text` | ASPS job ID | sync 시 기록 |
| `remoteId` | `rich_text` | 1000.school ID | 작성 단계에서 기록 |
| `suggestion` | `rich_text` | `organize` 결과 | AI 제안 단계에서 기록 |
| `score` | `rich_text` 또는 숫자로 변환 가능한 `number` | `feedback` 결과 | AI 채점 단계에서 기록 |
| `lastError` | `rich_text` | 안전한 오류 코드 | 실패 시 기록 |

현재 sync 대상 status 값은 정확히 `전송대기`다. 해당 page의 child block을 순서대로 읽어 plain text와 SHA-256 content hash를 만든다. 지원하지 않는 block은 `[Unsupported block: ...]` placeholder와 warning으로 남긴다.

## 처리 흐름

1. 활성 profile의 data source를 pagination으로 조회한다.
2. 각 page의 child block을 pagination하고 tree를 hydrate한다.
3. `date`, `status`, content를 변환한다.
4. status가 `전송대기`이고 date/content가 유효하면 job을 만든다.
5. `userId + profileId + notionPageId + targetDate + contentHash + mode`로 중복을 막는다.

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
