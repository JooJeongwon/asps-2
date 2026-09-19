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
  "status": "상태"
}
```

실제 property 이름은 사용자마다 다를 수 있으므로 기본값을 계약으로 강제하지 않는다.

## page property

| Mapping key | 권장 Notion type | 용도 | 현재 구현 |
| --- | --- | --- | --- |
| `title` | `title` | 초안 식별용 제목 | mapping 보관 |
| `date` | `date` | job `targetDate` | 읽기 |
| `status` | `select` 또는 `status` | 전송 대상 판별 | 읽기 |
| `remoteId` | `rich_text` | 1000.school ID | 후속 단계 |
| `suggestion` | `rich_text` 또는 page content | AI 제안 | 후속 단계 |
| `score` | `number` | AI 점수 | 후속 단계 |
| `lastError` | `rich_text` | 안전한 오류 코드 | 후속 단계 |

현재 sync 대상 status 값은 정확히 `전송대기`다. 해당 page의 child block을 순서대로 읽어 plain text와 SHA-256 content hash를 만든다. 지원하지 않는 block은 `[Unsupported block: ...]` placeholder와 warning으로 남긴다.

## 처리 흐름

1. 활성 profile의 data source를 pagination으로 조회한다.
2. 각 page의 child block을 pagination하고 tree를 hydrate한다.
3. `date`, `status`, content를 변환한다.
4. status가 `전송대기`이고 date/content가 유효하면 job을 만든다.
5. `userId + profileId + notionPageId + targetDate + contentHash + mode`로 중복을 막는다.

Notion database의 실제 property type과 샘플 page는 사용자가 연결할 workspace에서 한 번 수동 확인해야 한다. 현재 저장소는 mapping으로 이름을 받지만 type mismatch를 사전 검증하지 않는다.
