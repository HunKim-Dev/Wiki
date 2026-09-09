---
name: wiki-validate
description: wiki 페이지의 스펙 준수(frontmatter·필수 섹션·링크 포맷·id/kind/path 일치) 검증. 🔴 위반 있으면 /wiki의 auto-commit 차단, 🟡는 경고. 사용자가 "/wiki-validate", "규격 검증", "페이지 스펙 확인"이라고 말하거나 /wiki 내부에서 Stage E로 호출.
---

# /wiki-validate — 스펙 준수 검증

모든 wiki 페이지가 **동일한 구조·규격**을 따르는지 검증. LLM의 검색·참조 일관성과 **쿼리 가능성**을 보장.

## /wiki-lint 와의 차이

| 스킬 | 검사 대상 | 비유 |
|---|---|---|
| `/wiki-lint` | **런타임 건강** — 깨진 링크·빈 페이지·고아·오래된 | "배관 상태 점검" |
| `/wiki-validate` (본 스킬) | **스펙 준수** — 페이지가 템플릿 규격을 따르는가 | "코드 리뷰·스타일 가드" |

두 스킬 모두 "자동 수정 금지, 리포트만" 원칙 (본 스킬은 `--auto-fix`로 trivial 건만 예외).

## 경로 해석

`/wiki`와 동일:
- `$WIKI_PATH`·`$WIKI_PROJECT_ORGS`·`$WIKI_DEFAULT_ORG` — settings.json 자동 주입. 검증 대상 wiki 루트는 `$WIKI_PATH/$ORG/$PROJECT/wiki/` (org 해석은 `/wiki` SKILL.md 참조)
- 프로젝트명 = cwd의 git root basename
- 엔진 레포 가드

## 인자

| 인자 | 기본 | 설명 |
|---|---|---|
| `--scope <project|all>` | `project` | 현재 프로젝트만 / `$WIKI_PATH` 전체 |
| `--deep` | off | 의미 검증 포함 (토큰 비용 증가) |
| `--auto-fix` | off | trivial 보정만 자동 적용 |
| `--mode <report|block>` | `report` | `block` — 🔴 있으면 exit 1 (/wiki가 commit 차단용으로 사용) |

## 스펙 (검사 기준)

### 1. Frontmatter 필수 필드

| 필드 | 타입 | 규칙 |
|---|---|---|
| `id` | string | `<kind>/<domain>/<kebab-slug>` 형식 (decisions는 `decision/<slug>`). **파일 경로와 일치** |
| `kind` | enum | concept / entity / decision / howto / clarification / lint-report / action 중 하나 |
| `title` | string | 비어있지 않음 |
| `source` | string | 레포 내 상대 경로. scope=project일 때 `$SRC`에 실존 확인 |
| `created` | ISO-8601 | `2026-04-23` 또는 `2026-04-23T00:00:00Z` |
| `updated` | ISO-8601 | 동일 |
| `tags` | array | 없으면 `[]` (null·단일 문자열 금지) |

### 2. 디렉토리 ↔ kind 일치 + 도메인 서브디렉토리

구조 규칙:
- `concepts/<domain>/*.md` → `kind: concept` (1단계 서브디렉토리 **필수**)
- `entities/<domain>/*.md` → `kind: entity` (1단계 서브디렉토리 **필수**)
- `decisions/*.md` → `kind: decision` (도메인 분할 **안 함**)

판정:
- kind 불일치 시 🔴
- **concepts/ 또는 entities/ 직속 파일** (도메인 서브디렉토리 없음) → 🟡 "도메인 지정 권장" (강제는 아님, 레거시 허용)
- **2단계 이상 서브디렉토리** (`concepts/events/temporary/x.md`) → 🔴 "깊이 제한 1단계"
- **도메인 이름이 kebab-case 아님** (`concepts/UserAuth/`, `concepts/user_auth/`) → 🔴

### 3. 필수 섹션 (모든 kind 공통)

- `## 요약` — 한 단락 요약 (**필수**)
- `## 관련` — 관련 wiki 페이지 링크 (**필수**, 양방향 링크의 기반)

**kind별 권장 (없어도 🟡, 있어야 🟢)**:
| kind | 권장 섹션 |
|---|---|
| concept | `## 상세`, `## 출처` |
| entity | `## 상세`, `## 변경 이력`, `## 출처` |
| decision | `## 배경`, `## 결정`, `## 대안` |

### 4. 내부 참조 포맷

- **`[[wiki-link]]` 형식만 허용** — LLM 파싱 일관성
- `[text](path.md)` markdown 스타일 발견 시 🔴
- 예외: 외부 URL (`[text](https://...)`)은 허용

### 5. ID ↔ 경로 일관성

도메인 서브디렉토리 반영:
- `id: concept/<domain>/<slug>` → 파일 경로 `concepts/<domain>/<slug>.md`
- `id: entity/<domain>/<slug>` → 파일 경로 `entities/<domain>/<slug>.md`
- `id: decision/<slug>` → 파일 경로 `decisions/<slug>.md` (도메인 없음)

예:
- `id: concept/auth/jwt-signing` ↔ `concepts/auth/jwt-signing.md` ✅
- `id: concept/jwt-signing` ↔ `concepts/jwt-signing.md` ✅ (레거시 — 🟡로 처리, 🔴 아님)
- `id: concept/auth/jwt-signing` ↔ `concepts/jwt-signing.md` → 🔴 불일치

레거시 허용 정책:
- 도메인 없는 id (`concept/<slug>` 3-세그먼트 아닌 2-세그먼트)도 **경로와 일치하면 🟡**만 (commit 차단 안 함). 이는 마이그레이션 전 기존 페이지 보호 장치.
- 완전히 새로 만드는 페이지는 도메인 포함 권장 (/wiki 스킬이 그렇게 생성).

### 6. Source 경로 실재 (scope=project일 때만)

- `source: src/auth/token.py` → `$SRC/src/auth/token.py` 파일 존재 확인
- 없으면 🟡 (소스 이동·삭제 가능성 — 완전 삭제면 wiki 페이지 obsolete 검토)

## 실행 절차

### 1. 페이지 열거

```bash
find "$WIKI_PATH/$ORG/$PROJECT/wiki" -name "*.md" -not -path "*/log.md" -not -path "*/index.md" -not -path "*/lint-reports/*"
```

scope=all이면 모든 프로젝트 순회.

### 2. 각 페이지 검증 (결정론적)

파일당:
- frontmatter 파싱 (YAML)
- 필드별 스펙 테이블 체크
- 섹션 헤더 추출 (`^## `)
- 내부 참조 패턴 (`\[.+\]\(.+\.md\)` vs `\[\[.+\]\]`)
- id ↔ 파일 경로 일치
- source 파일 실재 (scope=project)

### 3. `--deep` 모드 의미 검증

- placeholder 섹션 감지 (본문이 `TODO`·`(아직 없음)`·30자 미만)
- 교차 참조 수 < 2 → 🟡
- 단독 tag (다른 페이지에 없는 tag) → 🟡 (오타 가능성)
- title ↔ id slug 의미 유사성 (제목이 전혀 다르면 🟡)

### 4. `--auto-fix` (제한적)

자동 보정하는 것:
- 빈 `tags` 필드 → `tags: []` 추가
- `created` 누락 → 파일 mtime 기준으로 채움
- `updated` 누락 → 오늘 날짜로 채움
- 섹션 순서 비표준 → 권장 순서로 재정렬 (헤더 레벨·내용 유지)

**자동 수정 안 하는 것**:
- 섹션 누락 생성
- frontmatter 필수 필드 신규 생성 (id, kind, title, source) — 잘못된 추론 위험
- id 불일치 해결 — 파일명 변경해야 하는지 id 변경해야 하는지 사용자 판단 필요
- 내부 참조 포맷 변환 — `[text](path.md)` → `[[wiki-link]]`은 slug 추론이 필요하니 사용자 확인

### 5. 리포트 저장

`$WIKI_PATH/$ORG/$PROJECT/wiki/lint-reports/<YYYY-MM-DD>-validate.md`:

```markdown
---
id: lint-report/<date>-validate
kind: lint-report
title: Wiki Spec Validation — <date>
created: <ISO-8601>
trigger: <manual|post-ingest>
mode: <shallow|deep>
scope: <project|all>
---

## 🔴 스펙 위반 (commit 차단 대상)

### Frontmatter 필드 누락 (<N>)
- `wiki/concepts/X.md` — `source` 필드 없음
- `wiki/entities/Y.md` — `tags` 필드 누락

### id ↔ path 불일치 (<N>)
- `wiki/concepts/foo-bar.md` has `id: concept/foo` (기대: concept/foo-bar)

### kind ↔ directory 불일치 (<N>)
- `wiki/entities/X.md` has `kind: concept` (기대: entity)

### 필수 섹션 누락 (<N>)
- `wiki/entities/X.md` — `## 관련` 섹션 없음
- `wiki/concepts/Y.md` — `## 요약` 섹션 없음

### 잘못된 내부 참조 포맷 (<N>)
- `wiki/X.md:L45` — `[text](path.md)` 스타일 발견, `[[wiki-link]]`로 변환 필요

### 잘못된 날짜 포맷 (<N>)
- `wiki/X.md` — `updated: 2026/04/23` (ISO-8601 아님)

## 🟡 검토 권장 (commit 차단 안 함)

### Source 파일 없음 (<N>)
- `wiki/concepts/X.md` — `src/old/file.py` 파일이 `$SRC`에 없음 (이동·삭제?)

### kind별 권장 섹션 누락 (<N>)
- `wiki/entities/X.md` — `## 상세` 권장

### 교차 참조 부족 (<N>) — --deep 전용
- `wiki/concepts/X.md` — 링크 1개 (>=2 권장)

### 단독 tag (<N>) — --deep 전용
- `wiki/X.md` — tag `leaderboards` (다른 페이지는 `leaderboard` — 오타 의심)

### placeholder 섹션 (<N>) — --deep 전용
- `wiki/X.md` — `## 상세` 본문이 `TODO` 한 단어

## 🟢 정상 통계

- 스펙 완전 준수 페이지: N / total
- frontmatter 완전성: N / total
- 링크 포맷 준수: N / total
- 공통 tag 어휘 수: N
```

### 6. 반환

scope=all이면 프로젝트별 소계 + 전체 합계 제공.

## /wiki 흐름 통합 — Stage E

`/wiki`가 Stage B(lint) 다음, Stage C(commit) 직전에 **Stage E — validate** 호출:

- 내부 실행: `/wiki-validate --mode block --scope project`
- 🔴 감지 시: Stage C(commit) **차단**, 사용자에게 보고:

```
❌ Stage E validate: 스펙 위반 <N>건 — auto-commit 차단됨.

위반 (🔴):
  - wiki/entities/X.md: `## 관련` 섹션 누락
  - wiki/concepts/Y.md: frontmatter `source` 필드 없음
  - wiki/Z.md: `id` ↔ 파일명 불일치

해결:
  1. 보고서 확인: wiki/lint-reports/<date>-validate.md
  2. 수동 수정 또는 /wiki-validate --auto-fix (trivial만)
  3. /wiki <source> 재실행 — 또는 /wiki-commit 수동 호출

변경된 wiki 파일은 commit되지 않았지만 디스크에는 유지됩니다.
```

- 🟡만 있고 🔴 없으면 Stage C 진행 + 경고 로그 남김.

## 엄격한 규칙

- **`--auto-fix` 범위 제한**: trivial(tags/created/updated/섹션 순서)만. 구조·필수필드·id 변경 금지
- 리포트 외 wiki 파일 수정 금지 (`--auto-fix` 예외)
- `$SRC` 소스 파일 절대 건드리지 않음
- 엔진 레포(wiki3/wiki4) 가드
- **모드 `block`일 때만** 🔴 발견 시 exit 1 (그 외엔 exit 0 — 리포트용)

## 반환

stdout JSON:
```json
{
  "status": "pass" | "violations-found" | "error",
  "scope": "project" | "all",
  "mode": "shallow" | "deep",
  "pages_checked": N,
  "violations_red": N,
  "violations_yellow": N,
  "pages_passed": N,
  "pages_with_red": ["wiki/..."],
  "auto_fixed": N,
  "auto_fixed_files": ["wiki/..."],
  "report_path": "wiki/lint-reports/..." | null,
  "blocks_commit": true | false,
  "violations_summary": {
    "frontmatter_missing": N,
    "id_path_mismatch": N,
    "kind_dir_mismatch": N,
    "required_section_missing": N,
    "wrong_link_format": N,
    "invalid_date_format": N,
    "source_missing": N
  }
}
```
