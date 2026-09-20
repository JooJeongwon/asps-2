# asps-2

각 사용자의 Notion과 1000.school 계정을 연결해 Daily snippet을 자동 처리하는 서비스입니다.

서비스 주소: <https://asps-2.jwjoo0512.workers.dev>

이 서비스는 팀 공용 계정을 사용하지 않습니다. 로그인한 사람의 Notion token, 1000.school token, 초안, 결과는 모두 해당 사용자에게만 연결됩니다. 팀원마다 본인의 token을 등록해야 합니다.

## 전체 UX 흐름

```text
Google 로그인
  → Notion 개발자 연결·database 설정
  → 1000.school API token 등록
  → asps-2 automation profile 생성
  → Notion에서 작성중으로 초안 작성
  → 작성완료로 변경
  → Notion Webhook이 asps-2에 전달
  → 작성 → AI 제안 → AI 채점 → 저장
  → Notion 상태·결과 확인
```

Webhook을 설정하지 않아도 대시보드의 `동기화` 버튼으로 수동 실행할 수 있습니다.

## 1. 준비할 값

팀원이 직접 준비하는 값은 다음 네 가지입니다.

| 값 | 어디서 준비하나요? | 설명 |
| --- | --- | --- |
| Notion Integration token | Notion Developer portal의 Internal connection | 본인이 사용할 Notion workspace 연결의 Installation access token |
| Notion Database ID | Notion database의 `Share → Copy link` | 링크 안의 36자리 database ID |
| Notion Data source ID | Notion의 `Manage data sources` 또는 Retrieve database API | asps-2가 페이지를 조회할 대상 data source ID |
| 1000.school API token | 본인의 1000.school 계정 | 비밀번호나 브라우저 cookie가 아닌 API token |

`Workspace 참조`, `Provider account 참조`, 1000.school token 만료 시각은 선택값입니다.

다음 값은 팀원이 입력하지 않습니다. 배포 운영자만 Cloudflare Secret으로 관리합니다.

- `CREDENTIAL_ENCRYPTION_KEY`
- `OAUTH_CLIENT_SECRET`
- `SESSION_SECRET`
- `WEBHOOK_SIGNING_SECRET`

어떤 token도 README, 채팅방, Git, URL query string에 남기지 마세요. token을 다른 사람과 공유하지 말고, 노출되면 해당 서비스에서 즉시 폐기 후 새 token을 발급합니다.

## 2. Notion 개발자 연결 만들기

각 팀원은 본인이 사용할 workspace와 database에 대한 연결을 따로 만듭니다. 하나의 Notion token을 여러 사람이 공유하지 않습니다.

1. Notion Developer portal에서 `Build → Internal connections`로 이동합니다.
2. `Create a new connection`을 선택하고 이름을 `asps-2-<이름>`처럼 지정합니다.
3. `Configuration`에서 다음 권한을 켭니다.
   - Read content
   - Update content
4. `Installation access token`을 복사합니다. 이 값이 asps-2의 Notion 연결 화면에 넣을 `Integration token`입니다.
5. 연결의 `Content access`에서 사용할 원본 database를 추가합니다.

Notion 페이지에서도 database를 열고 우측 상단 `••• → Connections → Add connection`으로 같은 연결을 추가할 수 있습니다. 연결을 만들기만 하고 database 공유를 하지 않으면 Notion API가 403을 반환합니다.

공식 안내: [Notion Internal connections](https://developers.notion.com/guides/get-started/internal-connections)

### Database ID와 Data source ID 확인

1. Notion에서 사용할 database를 전체 페이지로 엽니다.
2. `Share → Copy link`를 눌러 링크를 복사합니다.
3. 링크의 `?v=` 앞에 있는 36자리 값이 `Database ID`입니다.
4. database의 `••• → Manage data sources`에서 data source ID를 복사합니다.

data source ID가 보이지 않으면 Notion 공식 `Retrieve a database` API 응답의 `data_sources[0].id` 값을 사용합니다. linked database가 아니라 원본 database를 연결해야 합니다.

공식 안내: [Notion databases와 ID 확인](https://developers.notion.com/guides/data-apis/working-with-databases)

## 3. Notion database 구성

asps-2는 database의 property 이름을 자동으로 추측하지 않습니다. 아래 property를 만들거나, 이미 다른 이름을 사용 중이면 대시보드에서 실제 이름을 입력합니다.

| 대시보드 mapping | 권장 이름 | Notion type | 용도 |
| --- | --- | --- | --- |
| 제목 | `제목` | Title | 초안 식별 |
| 날짜 | `날짜` | Date | 1000.school 작업 날짜 |
| 상태 | `상태` | Select 또는 Status | 실행 트리거와 처리 상태 |
| asps-2 job ID | `asps-2 Job ID` | Rich text | asps-2 작업 ID |
| 1000.school ID | `1000school ID` | Rich text | 원격 snippet ID |
| AI 제안 | `AI 제안` | Rich text | AI 제안 결과 |
| AI 채점/피드백 | `AI 피드백` | Rich text 또는 Number | AI 채점 결과 |
| 마지막 오류 | `마지막 오류` | Rich text | 안전한 오류 코드 |

본문은 property가 아니라 Notion page 안의 block으로 작성합니다. page 안의 block이 asps-2가 1000.school로 보낼 초안입니다.

`상태` property에는 다음 옵션을 만듭니다.

```text
작성중
작성완료
처리중
완료
오류
```

작성 중인 page는 `작성중`으로 두고, 전송할 때만 `작성완료`로 바꿉니다. `작성완료`가 자동 실행 트리거입니다.

## 4. 1000.school API token 준비

1. 본인의 1000.school 계정으로 로그인합니다.
2. 계정의 API token 또는 개발자 설정에서 개인 API token을 발급합니다.
3. 생성 직후 표시되는 token을 안전한 임시 장소에 복사합니다.
4. asps-2 대시보드의 `연결 → 1000.school 연결 → API token`에 붙여 넣습니다.

1000.school API token은 본인의 계정에 발급된 값이어야 합니다. 다른 사람의 token, 로그인 비밀번호, 전체 browser cookie를 넣지 않습니다. API token 발급 메뉴가 보이지 않으면 1000.school 계정의 API 사용 권한을 운영자에게 확인하세요.

## 5. asps-2에서 초기 설정

### 5-1. 로그인

<https://asps-2.jwjoo0512.workers.dev>에 접속해 Google 계정으로 로그인합니다.

### 5-2. Notion 연결 저장

대시보드의 `연결 → Notion 연결`에 다음처럼 입력합니다.

| 입력란 | 넣을 값 |
| --- | --- |
| Integration token | Notion Internal connection의 Installation access token |
| Database ID | 사용할 원본 database ID |
| Data source ID | 해당 database의 data source ID |
| Workspace 참조 | 선택. workspace 이름 등 식별용 메모 |
| 제목 property | 실제 제목 property 이름 |
| 날짜 property | 실제 날짜 property 이름 |
| 상태 property | 실제 상태 property 이름 |
| asps-2 job ID property | 실제 job ID property 이름 |
| 1000.school ID property | 실제 원격 ID property 이름 |
| AI 제안 property | 실제 제안 property 이름 |
| AI 채점/피드백 property | 실제 점수·피드백 property 이름 |
| 마지막 오류 property | 실제 오류 property 이름 |

권장 property 이름을 그대로 만들었다면 기본값을 수정하지 않고 저장하면 됩니다. 저장 후 token 전체 값은 화면에 다시 표시되지 않습니다.

### 5-3. 1000.school 연결 저장

`연결 → 1000.school 연결`에서:

- `API token`: 본인의 1000.school API token
- `Provider account 참조`: 선택. 계정 식별용 메모
- `만료 시각`: token에 만료가 있을 때만 입력

저장 후 상태가 `ACTIVE`인지 확인합니다.

### 5-4. `asps-2 기본` automation profile 생성

`Automation profile`에서 다음처럼 생성합니다.

| 입력란 | 권장값 |
| --- | --- |
| 이름 | `asps-2 기본` |
| 기본 실행 단계 | `FULL_AUTO` |
| Notion connection | 방금 저장한 본인의 Notion 연결 |
| 1000.school account | 방금 저장한 본인의 1000.school 연결 |

`Profile 생성`을 누른 뒤 profile이 `활성`인지 확인합니다. `FULL_AUTO`는 작성 → AI 제안 → AI 채점 → 저장을 모두 실행합니다.

다른 실행 단계는 다음과 같습니다.

- `DRAFT_ONLY`: 1000.school 초안 작성까지만 실행
- `SUGGEST`: 초안 작성과 AI 제안까지 실행
- `SCORE`: AI 채점 단계까지 실행
- `SAVE`: 최종 저장까지 실행
- `FULL_AUTO`: 전체 실행

처음 연결을 확인할 때는 `DRAFT_ONLY` 또는 `SUGGEST`로 테스트한 뒤 `FULL_AUTO`로 바꿔도 됩니다.

## 6. Notion Webhook 설정

Webhook을 등록하면 Notion에서 `작성완료`로 바꾸는 순간 자동 실행됩니다.

### 6-1. Webhook URL 만들기

대시보드의 `연결`에서 Notion connection ID를 확인합니다. 아래 URL의 `<notion-connection-id>`를 본인의 ID로 바꿉니다.

```text
https://asps-2.jwjoo0512.workers.dev/api/webhooks/notion/<notion-connection-id>
```

### 6-2. Notion에서 subscription 생성

1. Notion Developer portal에서 본인의 `asps-2-<이름>` connection을 엽니다.
2. `Webhooks` 탭에서 `Create a subscription`을 누릅니다.
3. 위 Webhook URL을 입력합니다.
4. 다음 event를 선택합니다.
   - `page.properties_updated`
   - `page.content_updated`
5. subscription을 생성합니다.

### 6-3. 최초 verification 완료

subscription 생성 직후 Notion이 Webhook URL로 `verification_token`을 한 번 보냅니다. 이 token을 다음 주소에서 본인 로그인 세션으로 확인합니다.

```text
https://asps-2.jwjoo0512.workers.dev/api/me/connections/notion/webhook-verification-token
```

응답의 `verificationToken` 값만 복사해 Notion Webhooks 화면의 `Verify` 입력란에 붙여 넣고 검증합니다. 이 URL을 다른 사람에게 보내거나 token을 query string, 로그, 채팅에 넣지 않습니다.

검증이 끝나면 Webhook 상태가 active인지 확인합니다. Webhook은 변경 직후 바로 오지 않고 수 초에서 수 분 걸릴 수 있습니다.

공식 안내: [Notion Webhooks](https://developers.notion.com/reference/webhooks)

> `x-asps-webhook-secret` header를 사용하는 별도 Webhook action 방식도 지원하지만, 일반 사용자의 기본 설정에는 필요하지 않습니다. 해당 방식은 운영자가 `WEBHOOK_SIGNING_SECRET`을 별도로 전달하고 Notion Button 또는 Database automation을 구성할 때만 사용합니다.

## 7. 첫 실행

1. 연결한 Notion database에 새 page를 만듭니다.
2. `날짜`에 1000.school 작업 날짜를 입력합니다.
3. `상태`를 `작성중`으로 둡니다.
4. page 본문에 Daily snippet 초안을 작성합니다.
5. 작성을 끝내고 `상태`를 `작성완료`로 바꿉니다.
6. 대시보드의 `Jobs`에서 job을 새로고침합니다.
7. 상태가 다음 순서로 진행되는지 확인합니다.

```text
PENDING → FETCHED → DRAFT_CREATED → AI_SUGGESTED → AI_SCORED → SAVED
```

Notion page도 `작성중 → 처리중 → 완료`로 바뀌고, `1000school ID`, `AI 제안`, `AI 피드백` property에 결과가 기록됩니다.

### Webhook 없이 수동 실행

Webhook을 아직 설정하지 않았다면 대시보드에서 `asps-2 기본` profile의 `동기화`를 누릅니다. asps-2가 database를 조회해 다음 조건을 만족하는 page만 job으로 등록합니다.

- 상태가 `작성완료`
- 날짜가 있음
- 본문이 비어 있지 않음
- 지원하는 Notion block으로 구성됨

동기화 결과에서 `queued`가 0이면 `skipped`와 warning을 확인합니다.

## 8. 실패·재시도

- `AUTH_REQUIRED`: Notion 또는 1000.school token을 다시 발급해 해당 연결을 갱신합니다.
- `CONTENT_CHANGED`: job 생성 후 Notion 본문이 바뀐 상태입니다. 최신 내용으로 다시 `작성완료` 처리합니다.
- `FAILED_RETRYABLE`: 일시적인 네트워크·429·5xx 오류입니다. `실패 단계 재시도`를 누릅니다.
- `FAILED_FINAL`: 사용자 확인이 필요한 오류입니다. `Jobs → 상세`에서 안전한 오류 코드만 확인합니다.
- Notion 상태가 `오류`이면 `마지막 오류` property를 확인합니다.

재시도 전에 Notion 본문이 최종본인지 확인하세요. 본문이 바뀌면 기존 AI 제안·점수는 새 내용에 대한 결과가 아니므로 저장하지 않습니다.

## 9. 보안 규칙

- 팀원마다 본인의 Notion connection과 1000.school token을 사용합니다.
- 다른 사람의 token, Notion cookie, 로그인 session cookie를 입력하지 않습니다.
- token을 Git, README, Notion 본문, URL, 브라우저 localStorage에 저장하지 않습니다.
- token이 노출되면 해당 서비스에서 즉시 revoke하고 새 token을 asps-2에 다시 저장합니다.
- 연결 해제 시 해당 연결을 사용하는 profile은 비활성화되고 대기 job은 취소됩니다.
- asps-2는 token 원문을 화면에 다시 보여주지 않습니다.

## 운영자용

### 개발·검증

```bash
npm install
npm run typecheck
npm test
npm run dev
```

### 배포 전 설정

`wrangler.jsonc`의 D1 `database_id`와 Queue 설정을 확인하고, Cloudflare Secret에 다음 값을 등록합니다.

- `CREDENTIAL_ENCRYPTION_KEY`
- `OAUTH_CLIENT_SECRET`
- `SESSION_SECRET`
- `WEBHOOK_SIGNING_SECRET`

Google OAuth Web application client의 callback URL은 다음 값과 정확히 같아야 합니다.

```text
https://asps-2.jwjoo0512.workers.dev/api/auth/callback
```

배포:

```bash
npm run deploy
```

### 관련 문서

- [사용자 흐름](docs/user-flow.md)
- [Notion schema](docs/notion-schema.md)
- [1000.school API 계약](docs/1000-school-api-contract.md)
- [아키텍처](docs/architecture.md)
- [1000.school API 문서](https://api.1000.school/docs#/)
