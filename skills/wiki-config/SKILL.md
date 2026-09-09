---
name: wiki-config
description: wiki-agent 설정을 인터랙티브 메뉴로 관리. 사용자에게 단계별로 질문해서 ~/.claude/settings.json을 안전하게 수정. install.js처럼 묻고 고르게 하는 UX. 위키 폴더·그룹·프로젝트 연결·검색 범위·자동 참조 on/off 등.
---

# /wiki-config — 인터랙티브 설정 관리

settings.json 직접 수정이 불편할 때 쓰는 안전한 설정 도구. 항상 **현재 상태 먼저 표시 → 메뉴 → 단계별 질문 → 사용자 승인 → 백업 → 적용 → 검증 → 보고**.

## 용어 가이드 (사용자 친화)

내부적으로는 영어 환경변수(`WIKI_*`)를 쓰지만 **사용자에게는 한국어로 표시**:

| 내부 표현 | 사용자 표현 | 의미 |
|---|---|---|
| Org / WIKI_ORGS | **그룹** | 회사·팀·프로젝트군 단위로 위키 분리 |
| WIKI_DEFAULT_ORG | **기본 그룹** | 프로젝트 매핑 없을 때 폴백 |
| WIKI_PROJECT_ORGS | **프로젝트 → 그룹 연결** | 어떤 프로젝트가 어떤 그룹에 속하는지 |
| WIKI_ORG_REMOTE_PATTERNS | **Git 주소 자동 매칭 규칙** | git remote URL로 자동 그룹 결정 |
| WIKI_PATH | **위키 저장 폴더** | 모든 wiki 파일 루트 경로 |
| WIKI_SCOPE | **검색 범위** | "같은 그룹 전체" vs "현재 프로젝트만" |
| WIKI_AUTOCONSULT | **자동 위키 참조** | 매 프롬프트마다 자동 발화 on/off |
| Hook | **자동 실행** | Claude가 사용자 입력 받을 때 실행되는 스크립트 |

답변·메뉴·질문에서는 **한국어 표현 우선**. 환경변수 이름은 "고급" 또는 "참고" 표기로만 노출.

## 절대 규칙

1. **변경 전 백업** — `~/.claude/settings.json.bak-<ISO>` 의무
2. **사용자 승인 필수** — 각 변경 전 y/n
3. **JSON 무결성 검증** — write 전후 둘 다 파싱 가능한지 확인
4. **Atomic write** — 임시 파일 → rename
5. **엔진 레포 가드** — cwd가 `$WIKI_ENGINE_ROOT` 하위면 settings 안 건드림
6. **즉시 효과** — settings.json은 매 hook 호출마다 reload되므로 다음 프롬프트부터 적용. 세션 재시작 불필요

## 처리 흐름

### Stage 1 — 현재 상태 표시 (사용자 친화)

```
📋 wiki-agent 현재 설정

📂 위키 저장 폴더
  ~/WorkSpace/wiki-docs ✅
  (모든 위키 파일이 여기 아래에 그룹·프로젝트 단위로 정리됨)

🏢 등록된 그룹 (회사·팀·프로젝트군 단위로 위키를 분리)
  - Initech
  - Contoso
  - Acme ⭐ 기본
  - Globex
  - Umbrella

🗂️ 프로젝트 → 그룹 연결
  web-front  → Acme
  admin-front → Acme
  (그 외 프로젝트는 기본 그룹 'Acme'으로 자동 연결)

🌐 Git 주소 자동 매칭 규칙
  (없음 — 추가하면 git remote URL로 그룹 자동 결정)

🔍 검색 범위
  현재: 같은 그룹 내 모든 프로젝트 (현재 프로젝트는 ×1.5 우선순위)
  대안: 현재 프로젝트만 (다른 프로젝트 위키 안 봄)

🤖 자동 위키 참조
  ✅ 활성 — 매 질문마다 자동으로 관련 위키 페이지 참조

🪝 자동 실행 등록
  ✅ Claude가 사용자 입력 받을 때 위키 hook 실행됨

📦 현재 위키 데이터 현황
  Acme/web-front (19 페이지)
  Acme/admin-front (24 페이지)
  Initech, Contoso, Globex, Umbrella — 아직 데이터 없음 (그룹만 등록)

💾 이전 설정 백업
  (없음 — 첫 변경 시 자동 생성됨)
```

`Bash` `ls $WIKI_PATH/<그룹>/`과 페이지 카운트로 데이터 현황 자동 산출.

### Stage 2 — 메뉴 (한국어 친화)

```
무엇을 하시겠어요?

[그룹 관리]
 1. 새 그룹 추가 (예: 회사명·팀명·프로젝트군)
 2. 그룹 제거
 3. 기본 그룹 변경 (프로젝트 매핑 없을 때 사용될 그룹)

[프로젝트 연결]
 4. 프로젝트를 그룹에 연결
 5. 프로젝트 연결 해제
 6. Git 주소 자동 매칭 규칙 추가/제거

[저장 위치]
 7. 위키 저장 폴더 변경

[동작 설정]
 8. 검색 범위 바꾸기 (같은 그룹 전체 ↔ 현재 프로젝트만)
 9. 자동 위키 참조 켜기/끄기

[기타]
10. 이전 설정으로 되돌리기 (백업 복원)
 q. 종료

선택 (번호 또는 자연어): _
```

번호 또는 자연어로 응답. 자연어면 의도 매칭 (예: "새 그룹 만들고 싶어" → 1).

### Stage 3 — 작업별 단계 (각 단계 사용자 친화 톤)

#### 1. 새 그룹 추가

```
🆕 새 그룹 추가

회사·팀·프로젝트군 단위로 위키를 분리할 수 있어요.
예: 'Acme Corp' 회사 / 'design-team' 팀 / 'mobile-apps' 프로젝트군

기존 그룹: Initech, Contoso, Acme, Globex, Umbrella

새 그룹 이름은? (영문·숫자·하이픈·언더스코어만)
> _

[검증]
- 이미 존재하는 이름인지 체크
- 형식 체크 (특수문자·공백 금지)

이 그룹을 '기본 그룹'으로 설정할까요?
(기본 그룹 = 프로젝트 매핑 없을 때 자동으로 연결되는 그룹)

선택 (y/n): _

[변경 미리보기]
변경 전:
  등록된 그룹: Initech, Contoso, Acme, Globex, Umbrella
  기본 그룹: Acme

변경 후:
  등록된 그룹: Initech, Contoso, Acme, Globex, Umbrella, Initrode  ← 추가
  기본 그룹: Initrode  ← 변경 (또는 Acme 유지)

적용할까요? (y/n)
```

#### 2. 그룹 제거

```
❌ 그룹 제거

현재 등록된 그룹:
  1. Initech (데이터 없음)
  2. Contoso (데이터 없음)
  3. Acme ⭐ 기본 — 50 페이지 (web-front, admin-front)
  4. Globex (데이터 없음)
  5. Umbrella (데이터 없음)

제거할 그룹 번호 또는 이름:
> _

[자동 검증·경고]
⚠️ 데이터 있는 경우 경고:
  "Acme 그룹에 50 페이지가 있어요. 제거하면 매핑된 프로젝트가 끊깁니다.
   wiki 파일 자체는 안 지웁니다 ($WIKI_PATH/Acme/ 그대로 남음).
   진짜 제거하시겠어요?"

⚠️ 기본 그룹 제거 시:
  "Acme이 기본 그룹입니다. 새 기본 그룹을 정해주세요."
  → 다른 그룹 선택 받기

⚠️ 매핑된 프로젝트 처리:
  "이 그룹에 연결된 프로젝트 2개:
    - web-front
    - admin-front
   연결을 함께 끊을까요? (y/n)"

[변경 미리보기 + 적용 승인]
```

#### 3. 기본 그룹 변경

```
⭐ 기본 그룹 변경

현재 기본 그룹: Acme
(프로젝트가 매핑 안 되면 이 그룹으로 자동 연결됨)

새 기본 그룹 선택:
  1. Initech
  2. Contoso
  3. Acme ← 현재
  4. Globex
  5. Umbrella

선택: _

[변경 미리보기 + 적용]
```

#### 4. 프로젝트를 그룹에 연결

```
🔗 프로젝트를 그룹에 연결

현재 cwd 프로젝트: my-new-app
이 프로젝트를 사용할까요? 또는 다른 프로젝트명 입력?
  (y → my-new-app 사용 / 또는 직접 입력)
> _

어느 그룹에 연결할까요?
  1. Initech
  2. Contoso
  3. Acme ⭐ 기본
  4. Globex
  5. Umbrella

선택: _

[변경 미리보기]
변경 전:
  web-front  → Acme
  admin-front → Acme
  (my-new-app은 매핑 없음 → 기본 'Acme'으로 자동 폴백)

변경 후:
  web-front  → Acme
  admin-front → Acme
  my-new-app         → Acme  ← 신규

적용? (y/n)
```

#### 5. 프로젝트 연결 해제

```
🔌 프로젝트 연결 해제

현재 연결:
  1. web-front  → Acme
  2. admin-front → Acme

해제할 연결 번호:
> _

⚠️ 해제 후엔 기본 그룹 'Acme'으로 자동 폴백됨 (실제 wiki 파일은 그대로).

[적용 승인]
```

#### 6. Git 주소 자동 매칭 규칙

```
🌐 Git 주소 자동 매칭 규칙

이 규칙이 있으면 프로젝트의 git remote URL을 보고 자동으로 그룹을 결정합니다.
명시적 매핑(메뉴 4번)보다 우선순위 낮음 (= fallback).

현재 규칙:
  (없음)

무엇을 하시겠어요?
  a. 규칙 추가
  b. 규칙 제거
  c. 취소

[a 선택 시]
URL 패턴 (substring 매칭):
  예: 'github.com/acme-inc' → Acme
  예: 'gitlab.com/acme-corp'   → Acme

패턴 입력:
> _

매핑할 그룹 (위 목록에서):
  1. Initech  2. Contoso  3. Acme  4. Globex  5. Umbrella
> _

[적용 승인]
```

#### 7. 위키 저장 폴더 변경

```
📂 위키 저장 폴더 변경

현재 위치: ~/WorkSpace/wiki-docs
이 폴더에 50 페이지가 있습니다.

새 위치 입력 (~ 사용 가능):
> _

[검증]
- ~ 확장 → 절대 경로
- 디렉토리 존재 여부 확인
  → 없으면: "이 경로에 폴더가 없어요. 새로 만들까요? (y/n)"
  → 있으면: 정상

기존 위키 데이터 처리:
  a. 새 위치로 복사 (cp -r) — 기존 50 페이지 옮김
  b. 그대로 두고 새 위치에서 빈 위키로 시작 — 기존 데이터는 옛 폴더에 남음
  c. 취소

⚠️ a 선택 시 새 위치에 이미 데이터 있으면:
  - 덮어쓰기 / 병합 / 취소 다시 묻기

[적용 승인]
```

#### 8. 검색 범위 바꾸기

```
🔍 검색 범위 변경

현재: 같은 그룹 전체 (org-wide)
   → 같은 그룹의 모든 프로젝트 위키를 검색
   → 현재 프로젝트는 ×1.5 우선순위로 상단 노출
   → 예: web-front 작업 중에 admin-front 위키도 자동 검색됨

대안: 현재 프로젝트만 (current)
   → 다른 프로젝트 위키는 절대 안 봄
   → 보안·집중도 이유로 격리 원할 때

선택:
  1. 같은 그룹 전체 ⭐ 기본
  2. 현재 프로젝트만 (strict 격리)

[적용 승인]
```

#### 9. 자동 위키 참조 켜기/끄기

```
🤖 자동 위키 참조 설정

현재: ✅ 활성

매 사용자 질문마다 hook이 자동으로 위키를 검색해 컨텍스트로 주입합니다.
이게 wiki-agent의 핵심 기능입니다.

변경 옵션:
  1. 비활성화 — 자동 검색 끔. wiki는 /wiki, /wiki-config 같은 명시 호출 시에만
  2. 다시 활성화 (현재 활성)
  3. 취소

⚠️ 비활성화 후에도 명시 슬래시 명령(/wiki, /wiki-config 등)은 그대로 동작합니다.

[적용 승인]
```

#### 10. 이전 설정으로 되돌리기

```
💾 이전 설정으로 되돌리기

사용 가능한 백업:
  1. settings.json.bak-2026-04-27T15:23:45  (10분 전)
  2. settings.json.bak-2026-04-27T14:10:11  (1시간 전)
  3. settings.json.bak-2026-04-26T09:00:00  (1일 전)

복원할 백업 번호:
> _

[복원 미리보기]
현재 → 복원될 값 비교 표시

복원? (y/n)
```

### Stage 4 — Atomic Write + 백업

승인 받은 후:

1. **백업**: 현재 `~/.claude/settings.json` → `~/.claude/settings.json.bak-<ISO>`
2. **임시 파일**: 새 settings를 `~/.claude/settings.json.new`에 작성
3. **JSON parse 검증**: `json.load()` 통과해야 다음 단계
4. **Atomic rename**: `settings.json.new` → `settings.json`
5. **검증**: 다시 읽어서 변경 사항 확인

### Stage 5 — 결과 보고 (한국어 친화)

```
✅ 설정 변경 완료

변경 내용:
  - 'Acme' 그룹 추가
  - 'my-new-app' 프로젝트를 'Acme' 그룹에 연결
  - 기본 그룹: Acme → Acme 변경

백업 파일: ~/.claude/settings.json.bak-2026-04-27T15:23:45
   (문제 생기면 메뉴 10번으로 복원 가능)

다음 프롬프트부터 새 설정 적용됩니다 (세션 재시작 불필요).

후속 권장:
  - cd ~/projects/my-new-app
  - /wiki 또는 그냥 질문 → 'Acme/my-new-app/wiki/' 자동 생성
  - 다시 확인하려면 /wiki-config
```

## 안전 가드

- `cwd`가 `$WIKI_ENGINE_ROOT`(이 패키지의 소스 트리) 하위면 즉시 종료 + "엔진 레포에선 wiki-config 사용 금지" 안내
- `~/.claude/settings.json` 파싱 실패 시 → "현재 settings 파일이 손상됐습니다" + 메뉴 10번 복원으로 직행
- 위키 저장 폴더 변경 시 기존 데이터 절대 자동 삭제 안 함 (사용자 명시 명령 없으면)
- 모든 메뉴 어디서든 q·취소·뒤로가기 가능

## 도구 사용

- `Read` — settings.json, 백업 파일
- `Write` — settings.json (atomic write)
- `Bash` — `ls`, `cp` (백업), `mkdir` (폴더 신규 생성), `find` (백업 목록)
- 사용자와의 대화로 입력 받기 (Claude Code의 일반 질문·답변 흐름)

## 반환

stdout JSON:

```json
{
  "status": "applied" | "cancelled" | "error",
  "operation": "add-group" | "remove-group" | "set-default-group" | "link-project" | "unlink-project" | "remote-pattern" | "change-path" | "change-scope" | "toggle-autoconsult" | "restore-backup",
  "before": {...},
  "after": {...},
  "backup_path": "~/.claude/settings.json.bak-..."
}
```
