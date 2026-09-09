---
name: wiki
description: 소스 문서(README, ADR, PR 설명, 회의록 등)를 읽고 LLM Wiki를 목적 단위(concept/entity/decision)로 기록한 뒤, 경량 lint + 자동 git commit까지 연속 수행. 사용자가 "위키에 반영해줘", "기록해줘", "/wiki <파일>"이라고 말할 때 호출.
---

# /wiki — 기록 + 점검 + 자동 커밋

한 번의 호출로 네 단계를 연속 수행:
- **단계 A** — 기록 (ingest): 소스 읽고 wiki 페이지 생성/업데이트
- **단계 B** — 경량 점검 (lint): 깨진 링크·빈 페이지·frontmatter
- **단계 E** — 스펙 검증 (validate): 규격 준수 검증 — 🔴 있으면 commit **차단**
- **단계 C** — 자동 커밋 (commit): `$WIKI_PATH` 변경사항 git commit (기본 ON, `--no-commit`으로 끔)

단계 E에서 🔴 발견되면 C는 skip (규격 위반이 커밋되는 걸 막음). 사용자가 수정 후 재실행해야 commit됨.
단계 C는 git repo 아니거나 변경 없으면 조용히 skip. 실패해도 A·B·E 결과는 유지.

**플래그**:
- `--no-commit` — 단계 C 건너뜀. 여러 번 ingest 후 수동으로 `/wiki-commit`하고 싶을 때.
- `--no-validate` — 단계 E 건너뜀 (권장하지 않음 — 스펙 품질 저하 위험).

## 언제 실행하나

- 새 문서·코드·PR 설명·ADR·회의록을 위키에 편입
- 외부 기술문서·README를 위키 지식으로 흡수
- 작업 목적 단위(예: "결제 모듈", "인증 플로우")로 관련 소스 여럿을 한 번에 기록

## 입력

- **소스 파일 경로(들)** 또는 **작업 목적 설명** 중 하나. 없으면 사용자에게 질문 (추측 금지).
- 예:
  - `/wiki README.md` — 파일 하나
  - `/wiki src/payment/*.ts docs/payment-flow.md` — 여러 파일 (목적 단위)
  - `/wiki "결제 재시도 로직 정리"` — 주제 서술 (Claude가 target repo에서 관련 파일 스캔)

## 경로 해석 — Org / Project 2단계 모델

`install.js`가 `~/.claude/settings.json`에 다음 env를 자동 주입:
- `WIKI_PATH` — 저장 루트 (예: `~/WorkSpace/wiki-docs`)
- `WIKI_ORGS` — 담당 조직 CSV 목록
- `WIKI_DEFAULT_ORG` — 기본 조직
- `WIKI_PROJECT_ORGS` — `project=org` CSV 매핑
- `WIKI_ORG_REMOTE_PATTERNS` — git remote URL 패턴 → org CSV 매핑

**사용자는 export 불필요** — Claude Code 시작 시 모두 자동 로드.

### 결정 규칙

- **소스 레포** — 현재 cwd에서 암묵 결정
  - `git rev-parse --show-toplevel` 성공 시 그 경로, 실패 시 cwd
- **프로젝트명** — 소스 레포의 **basename**
- **조직(Org)** — 다음 우선순위로 해석:
  1. **(a) 명시 매핑** — `WIKI_PROJECT_ORGS`에 `<project>=<org>` 있으면 그 org
  2. **(c) Git remote 패턴** — `WIKI_ORG_REMOTE_PATTERNS`의 substring 매칭
  3. **(default)** — `WIKI_DEFAULT_ORG`
- **출력 루트** — `$WIKI_PATH/<org>/<project>/`
  - 예: project=`web-front`, org=`Acme` → `$WIKI_PATH/Acme/web-front/`

### 실행 전 확인 (실패 시 중단)

```bash
: "${WIKI_PATH:?WIKI_PATH 미설정 — 'npm install -g wiki-for-claude' 실행 후 재시도}"
[ -d "$WIKI_PATH" ] || { echo "WIKI_PATH 존재 안 함: $WIKI_PATH"; exit 1; }
SRC=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROJECT=$(basename "$SRC")
# Org 해석 (env 기반)
ORG=""
# (a) 명시 매핑 — WIKI_PROJECT_ORGS에서 project= 프리픽스 검색
if [ -n "$WIKI_PROJECT_ORGS" ]; then
  ORG=$(echo "$WIKI_PROJECT_ORGS" | tr ',' '\n' | grep "^$PROJECT=" | head -1 | cut -d= -f2)
fi
# (c) Git remote 패턴 (생략 — Claude가 LLM으로 판단하거나 hook이 이미 처리)
# (default)
[ -z "$ORG" ] && ORG="$WIKI_DEFAULT_ORG"
OUT="$WIKI_PATH/$ORG/$PROJECT"
mkdir -p "$OUT"
```

**신규 프로젝트 첫 `/wiki`일 때** — 매핑에 없고 DEFAULT_ORG로 자동 귀속됐으면 **사용자에게 확인**:
```
이 프로젝트(<project>)의 org가 매핑되지 않아 기본값 <DEFAULT_ORG>로 귀속합니다.
다른 org에 속한다면 settings.json의 WIKI_PROJECT_ORGS 편집 권장.
계속? (y/n)
```

### 엔진 레포 가드

`$SRC`가 `$WIKI_ENGINE_ROOT`(이 패키지의 소스 트리, install 시 settings.json env에 주입됨) 하위이거나 `llm-wiki-graphify-skills-design-v2.md`를 포함하면 **중단** — 엔진 자체 수정 금지.

### 원본 오염 구조적 방지

`$WIKI_PATH`는 `$SRC` 외부에 있음. 모든 쓰기는 `$OUT` (`$WIKI_PATH/$ORG/$PROJECT`) 하위로만. 소스 오염 불가능.

이하 본문의 `wiki/...`는 **`$OUT/`** 기준 (즉 `$WIKI_PATH/$ORG/$PROJECT/`). `src/...` 등 소스 참조는 `$SRC/` 기준.

## 단계 A — 기록 (ingest)

### A-1. 소스 읽기

- 지정된 파일(들)을 원 위치에서 Read. 복사본(`raw/`) 생성 금지 — 원 경로를 wiki 페이지 frontmatter의 `source` 필드로 기록해 감사 추적.
- 소스 파일은 **절대 수정하지 않는다**.
- 외부 시스템(Jira/Notion) 문서는 사용자가 레포 내 경로(예: `docs/external/jira-PAY-123.md`)로 export한 후 ingest하도록 안내. 에이전트가 외부 시스템 접근하지 않음.

### A-2. 엔티티·개념 추출

- 핵심 엔티티(서비스·모듈명), 개념, 결정사항, 행위자를 뽑는다.
- 소스 유형 감지: PR diff / ADR / 회의록 / 티켓 / 문서 / 코드.

### A-3. index.md + 도메인 택소노미 참조

- `wiki/index.md`를 Read. 없으면 빈 템플릿으로 초기화.
- **도메인 택소노미 파악** — `wiki/concepts/`와 `wiki/entities/` 하위의 **서브디렉토리 이름들이 곧 도메인 목록**. 예: `concepts/auth/`, `concepts/events/`, `entities/data/` 존재하면 도메인은 `auth`, `events`, `data`.
- 기존 관련 페이지 10~15개 파악 — 같은 엔티티·개념·도메인을 다루는 페이지 우선.
- 맥락 부족 감지 기준:
  - 모호한 약어·고유명사 (여러 해석 가능)
  - 결정 근거가 소스에 없음
  - 기존 wiki 페이지와 **명백한 충돌** 징후
  - 새 페이지를 어느 도메인에 넣을지 **기존 도메인에 속하지 않음** (신규 도메인 필요)
- 부족하면 `/wiki-clarify`를 호출해 사용자에게 최대 3개 질문 (단, 50% 이상 추론 가능하면 진행).

### A-4. 페이지 생성·업데이트 (한 번에 10~15개)

**디렉토리 구조 — 도메인 서브디렉토리 1단계**:

- `wiki/concepts/<domain>/<kebab-slug>.md` — 개념 (예: `concepts/auth/jwt-signing.md`)
- `wiki/entities/<domain>/<kebab-slug>.md` — 엔티티·서비스·모듈 (예: `entities/events/payment-service.md`)
- `wiki/decisions/adr-NNN-<slug>.md` — 결정·ADR (**도메인 분할 안 함** — ADR은 프로젝트 전체·시간순 관리)

**도메인 결정 규칙**:

1. **기존 도메인 우선**: `concepts/`와 `entities/` 하위 기존 서브디렉토리 이름 중 가장 가까운 것 선택
2. **주 도메인 하나만**: 여러 도메인과 연관되는 페이지는 **가장 주된** 도메인 하나에 배치, 나머지는 `## 관련` 링크로 연결
3. **신규 도메인 생성**:
   - 기존 도메인에 전혀 안 맞으면 새 도메인 제안 (프로젝트 첫 ingest엔 이게 정상)
   - 도메인 이름은 **kebab-case** (`auth`, `user-auth`, `event-temporary`)
   - Manual 모드에선 사용자 승인 후 생성, auto 모드는 50%+ 확신 시 자동
4. **1단계 깊이 제한**: `concepts/events/temporary/<slug>.md` 같은 2+ 단계 금지. 필요하면 도메인 이름을 세분화 (`events-temporary`)
5. **판정 불가 임시**: 정말 못 정하겠으면 `misc/` 도메인에 넣고 🟡 플래그 — 나중에 재분류

**생성·수정 금지 디렉토리**:
- `wiki/actions/` — `/wiki-resolve` 전용. 읽기는 판례 탐지용으로만 가능.
- `wiki/clarifications/` — `/wiki-clarify` 전용.
- `wiki/lint-reports/` — 단계 B(lint)·E(validate)가 채움.

각 페이지 frontmatter는 **표준 고정**, 임의 변형 금지:

```yaml
---
id: <kind>/<domain>/<kebab-slug>         # 예: concept/auth/jwt-signing
                                          # decisions는 예외: decision/adr-NNN-<slug>
kind: concept | entity | decision | howto | clarification
title: <페이지 제목>
source: <레포 내 원본 경로>                # 예: docs/ADR-001-auth.md
created: <ISO-8601>
updated: <ISO-8601>
tags: []
---
```

#### kind별 섹션 템플릿

**공통 필수**: 모든 kind에 `## 요약`, `## 관련`, `## 출처` 3개는 반드시 포함.

---

**concept** (개념·패턴·기법):

```markdown
# <제목>

## 요약
한 단락으로 개념의 핵심과 적용 맥락.

## 상세
구현 방법, 코드 스니펫, 트레이드오프. 모든 교차 참조는 `[[wiki-link]]` 형식.

## 관련
- [[<다른-페이지>]]

## 출처
- `<원본 경로>`
- (있으면) PR-NNN, JIRA-NNN
```

---

**entity** (서비스·모듈·이벤트·데이터):

```markdown
# <제목>

## 요약
이 엔티티가 무엇이고 현재 상태.

## 상세
구조·구성요소·경로·현재 구현. `[[wiki-link]]` 형식으로 관련 개념 참조.

## 변경 이력
시간순 주요 변경(커밋 SHA·날짜·의도):
- `<SHA>` (<YYYY-MM-DD>) — <변경 내용>
- …

## 관련
- [[<다른-페이지>]]

## 출처
- `<원본 경로>`
- (있으면) PR·티켓
```

---

**decision** (ADR — 아키텍처 의사결정):

```markdown
# <ADR-NNN 제목>

## 요약
한 단락: **결정**을 한 줄로 시작 + 핵심 영향 요약.

## 배경
**왜 이 결정이 필요했나** — 계기·제약·당시 상황.

## 결정
**무엇을 정했나** — 구체 방식·절차·규칙.

## 대안
고려했던 선택지들과 각각의 채택·거부 사유:

### (거부) 대안 A
- **거부 사유**: …

### (거부) 대안 B
- **거부 사유**: …

### (채택) 선택된 안
- **채택 사유**: …

## 상세
구체 구현 범위, 커밋 목록, 템플릿, 후속 작업 절차 등 부가 정보.

## 관련
- [[<다른-페이지>]]

## 출처
- PR-NNN, 커밋 SHA, 이슈 링크
```

---

**howto / clarification**: concept 템플릿 준용.

**주의**: 섹션 누락은 `/wiki-validate` 🟡로 감지. 🔴(commit 차단)은 `## 요약`·`## 관련` 공통 필수 2개 누락 시만.

### A-5. 교차 참조·index·로그·analytics

- 내부 참조는 전부 `[[wiki-link]]` 형식.
- **양방향 링크 강제 (필수)** — 신규/업데이트 페이지 X가 `[[Y]]`를 참조하면, **Y의 `## 관련` 섹션에도 X를 역참조 추가**한다. 참조 대상이 N개면 **N개 파일을 모두 update 대상에 포함**. 이게 Karpathy 스펙의 "10~15 페이지 update" 규모가 자연스럽게 달성되는 메커니즘이다.
  - 예: 신규 `concept/foo`가 `entity/bar`·`concept/baz` 2개를 참조 → `entity/bar.md`·`concept/baz.md` 둘 다 `## 관련`에 `- [[concepts/foo]]` 라인 추가.
  - 이미 `## 관련`에 있으면 중복 추가 금지 (멱등).
  - 업데이트도 동일 — 기존 페이지에 새 link 추가했으면 그 대상도 역참조 추가.
- `wiki/index.md` **항상** 갱신 — 신규 페이지 등록, 범주별 섹션 정렬.
- `wiki/log.md`에 append: `[ISO-8601] ingest: <source> → <N>개 페이지 업데이트 (신규 X, 수정 Y, back-link 보정 Z)`.
- **Analytics 로그** (필수) — `/wiki` 실행 결과를 `~/.claude/hooks/wiki-ingest.tsv`에 한 줄 append (없으면 헤더 포함해 신규 생성):

  ```bash
  TSV=~/.claude/hooks/wiki-ingest.tsv
  [ -s "$TSV" ] || echo -e "timestamp\tevent\tproject\tsource\tpages_created\tpages_updated\tbacklink_updates\tdomains_touched" > "$TSV"
  echo -e "$(date -Iseconds)\tingest\t$PROJECT\t<source>\t<N_new>\t<N_updated>\t<N_backlink>\t<domain1,domain2>" >> "$TSV"
  ```

- **Inverted Index 증분 갱신** (필수) — 이번 ingest에서 생성/수정된 페이지들을 인덱스에 반영:

  ```bash
  python3 "$WIKI_ENGINE_ROOT/scripts/hooks/wiki-build-index.py" --incremental \
    "$WIKI_PATH/$ORG/$PROJECT/wiki" \
    <수정된 페이지 rel_path 1> <수정된 페이지 rel_path 2> ...
  ```

  예: concepts/auth/jwt.md 생성 + entities/auth/token-service.md 수정 → 두 경로 넘김.

  - 기존 인덱스 없거나 손상되면 자동으로 전체 rebuild로 전환 (builder가 알아서 처리).
  - 실패해도 Stage B/E/C 진행 — hook은 인덱스 stale 감지 시 grep fallback 하므로 기능 유지.
  - 인덱스 미갱신 → hook이 최신 페이지 검색 못 함 → 방금 저장한 지식이 다음 질문에 바로 활용 안 됨. **반드시 기록**.

### A-6. 모순 플래그

- 기존 wiki와 소스 내용이 충돌하면 **자동 해결 금지**. 해당 페이지 상단에 `> 🔴 모순: <한 줄 설명>` 인용 블록으로 표시.
- 필요 시 `/wiki-resolve`로 후속 해결.

## 단계 B — 경량 점검 (lint)

단계 A가 끝나면 **무조건** 아래 구조적 점검을 수행한다 (LLM 없이 결정론적으로 처리 가능). 모든 것은 `wiki/**/*.md`을 대상으로 하되 `wiki/actions/**`, `wiki/clarifications/**`, `wiki/log.md`, `wiki/lint-reports/**`는 제외.

### B-1. 깨진 `[[wiki-link]]` 탐지

- 각 페이지의 `[[link]]` 추출 → 대상 파일 존재 확인.
- 끊어진 링크 목록화.

### B-2. index.md 누락 항목

- `wiki/` 실제 페이지 목록 vs `wiki/index.md` 등록 항목 비교.
- index에 안 올라간 페이지 탐지.

### B-3. 빈 페이지

- frontmatter만 있고 본문이 100바이트 미만이면 빈 페이지로 표시.

### B-4. frontmatter 필수 필드 검증

- `id`, `kind`, `source`, `updated` 네 개 중 하나라도 누락 시 표시.

### B-5. 결과 분류 및 리포트

사용자에게 **간결한 요약**을 stdout으로 보고. 문제가 있을 때만 `wiki/lint-reports/<YYYY-MM-DD>-lightweight.md`에 리포트 저장 (문제 0건이면 파일 생성 생략).

리포트 포맷:

```markdown
---
id: lint-report/<date>-lightweight
kind: lint-report
title: Wiki Lint (lightweight) — <date>
created: <ISO-8601>
trigger: post-ingest
---

## 🔴 즉시 해결

### 깨진 링크 (<N>)
- `wiki/X.md:L<line>` → `[[concepts/Y]]` 대상 없음

### frontmatter 누락 (<N>)
- `wiki/X.md` — `source` 필드 없음

### 빈 페이지 (<N>)
- `wiki/X.md` (<bytes> bytes)

## 🟡 검토 권장

### index.md 미등록 (<N>)
- `wiki/concepts/new-thing.md`

## 🟢 정상
- 링크 무결성: <OK / N개 문제>
- frontmatter: <OK / N개 누락>
```

본 스킬의 lint는 **경량 모드만**. 고아·오래된·의미 모순 등 무거운 점검은 독립 `/wiki-lint` 호출에서 `--mode full`로 수행.

## 단계 E — 스펙 검증 (필수, `--no-validate`로만 skip)

`/wiki-validate --mode block --scope project` 로직을 **인라인 수행**. 목적: LLM이 찾기 좋은 규격화된 구조가 유지되도록 **강제**.

### E-1. 검증 항목 (자세한 스펙은 `/wiki-validate` SKILL.md 참조)

결정론적 검사:
- Frontmatter 필수 필드 (id, kind, title, source, created, updated, tags)
- id ↔ 파일 경로 일치 (`concepts/foo.md` → `id: concept/foo`)
- kind ↔ 디렉토리 일치 (`entities/` → kind=entity)
- 필수 섹션 `## 요약`, `## 관련` 존재
- 내부 참조 `[[wiki-link]]` 포맷 (markdown 링크 스타일 🔴)
- 날짜 ISO-8601 포맷

### E-2. 🔴 발견 시 동작

commit을 **차단**하고 사용자에게 보고:

```
❌ Stage E validate: 스펙 위반 <N>건 — auto-commit 차단됨.

위반 (🔴):
  - wiki/entities/X.md: `## 관련` 섹션 누락
  - wiki/concepts/Y.md: frontmatter `source` 필드 없음
  - wiki/Z.md: `id: concept/foo` ↔ 파일명 `foo-bar.md` 불일치

해결:
  1. 보고서 확인: wiki/lint-reports/<date>-validate.md
  2. 수동 수정 후 /wiki <source> 재실행 (또는 /wiki-commit)
  3. trivial 수정은 /wiki-validate --auto-fix 가능

변경된 wiki 파일은 디스크에 유지됩니다 (commit만 막혔음).
```

Stage C를 **skip**하고 Stage D(결과 보고)로 직행.

### E-3. 🟡만 있고 🔴 없으면

경고만 로그에 남기고 Stage C(commit) 진행. 🟡는 장기적 개선 대상.

### E-4. 신규 ingest 규격 보증

단계 A(ingest)가 새 페이지를 만들 때부터 스펙을 따라야 함. Stage E는 사후 검증이지만, A에서 규격 어긋나면 E에서 차단되어 결국 commit 안 됨 → **A가 처음부터 맞게 쓰도록 강제됨**.

## 단계 C — 자동 커밋 (선택, 기본 ON)

`--no-commit` 플래그가 없고 아래 조건 전부 만족하면 `$WIKI_PATH` 변경사항을 git commit. **/wiki 안에서만 예외적으로 비대화형 auto-commit** — 메시지는 이번 ingest의 log.md 엔트리 기반으로 자동 생성.

### C-0. 실행 조건 (모두 AND, 하나라도 실패 시 조용히 skip)

```bash
# 1) 플래그 확인
[ "$1" = "--no-commit" ] && exit 0
# 1.5) Stage E에서 🔴 발견 시 여기까지 오지 않음 (이미 Stage D로 건너뜀)

# 2) 엔진 레포 가드 (WIKI_ENGINE_ROOT = 이 패키지 소스 트리)
if [ -n "$WIKI_ENGINE_ROOT" ]; then
  case "$WIKI_PATH" in
    "$WIKI_ENGINE_ROOT"|"$WIKI_ENGINE_ROOT"/*) exit 0 ;;
  esac
fi

# 3) git repo 존재
[ -d "$WIKI_PATH/.git" ] || exit 0  # not a repo — skip silently

# 4) 실제 변경 있음
[ -n "$(git -C "$WIKI_PATH" status --short)" ] || exit 0  # nothing to commit
```

skip하면 사용자에게 한 줄 알림만: `(auto-commit skipped: no .git or no changes)`.

### C-1. 메시지 자동 생성

방금 단계 A-5에서 log.md에 append한 **마지막 한 줄**을 추출 + 프로젝트명·페이지 통계 결합:

```
wiki: <프로젝트> — <source 요약 30자 이내>

- [<ISO-8601>] <N>개 페이지 (신규 X, 수정 Y, back-link Z)
- 출처: <source 경로>

🤖 Auto-commit via /wiki
```

예:
```
wiki: web-front — Xeno Point 스피너 로직 기록

- [2026-04-23T16:50:00Z] 9개 페이지 (신규 2, 수정 5, back-link 2)
- 출처: hooks/events/temporary/useXenopointchallenge.ts

🤖 Auto-commit via /wiki
```

### C-2. 커밋 실행 (비대화형)

```bash
git -C "$WIKI_PATH" add -A
git -C "$WIKI_PATH" commit -m "$(cat <<'EOF'
<메시지>
EOF
)"
NEW_SHA=$(git -C "$WIKI_PATH" rev-parse HEAD)
```

- **`--no-verify` 절대 금지** — pre-commit hook 있으면 따름
- **`--amend` 금지** — 항상 새 커밋
- **Force 옵션 금지**
- **Push 안 함** — push가 필요하면 `/wiki-commit --push` 별도 호출

### C-3. 에러 처리

- pre-commit hook 실패 → 사용자에게 실패 사유 그대로 보고 + 중단. wiki 변경은 그대로 두고 사용자가 수동 대응.
- git 자체 에러(lock, permission 등) → 동일하게 보고 + 중단.
- 성공 시 Stage D(결과 보고) 진입.

## 단계 D — 결과 보고

```
✅ ingest + lint + validate + commit 완료

Ingest:
  - 신규 페이지: X
  - 수정 페이지: Y
  - back-link 보정: Z
  - 🔴 모순 플래그: N (있으면 나열)

Lint (lightweight):
  - 깨진 링크: N / frontmatter 누락: N / 빈 페이지: N / index 미등록: N
  - 리포트: wiki/lint-reports/<date>-lightweight.md (문제 있을 때만)

Validate (spec):
  - 🔴 N건 / 🟡 N건 / 통과 N/total
  - 리포트: wiki/lint-reports/<date>-validate.md (위반 있을 때만)

Commit:
  - SHA: <앞 7자>  OR  차단 (🔴 N건 — validate 위반)
  - 메시지: <첫 줄>

다음 단계 (필요 시):
  - push: /wiki-commit --push
  - 깊은 점검: /wiki-lint --mode full
  - 스펙 보정: /wiki-validate --auto-fix
  - 판례 해결: /wiki-resolve
```

## 엄격한 규칙

- 원본 소스 파일 **절대 수정 금지**.
- `raw/` 디렉토리 생성 금지 — 원 경로를 frontmatter `source`에 기록.
- 한 번의 기록에서 **10~15개 페이지** 업데이트 (많아도 20개 초과 금지). 이 수치는 양방향 링크 연쇄 업데이트(A-5) 결과로 자연스럽게 나와야 함 — 인위적으로 맞추려고 무관한 페이지 건드리지 않음.
- 모든 내부 참조는 `[[wiki-link]]`.
- **양방향 링크 완전성** — 어떤 신규·업데이트 페이지가 `[[Y]]`를 참조했는데 `Y`의 `## 관련`에 역참조가 없으면 **완료로 간주하지 않음**. 반드시 `Y` 파일도 수정한다 (A-5 참조).
- 모순은 자동 해결 금지, 🔴 플래그만.
- `wiki/index.md`는 **항상** 갱신.
- `wiki/actions/`, `wiki/clarifications/`는 본 스킬이 **쓰지 않음**.
- lint는 **자동 수정 금지**. 리포트만.
- frontmatter 필드명은 템플릿 그대로. `kind` (not `type`), `source` (not `sources`).
- 엔진 레포(`$WIKI_ENGINE_ROOT`) 수정 금지.
- **자동 commit 안전 가드**: git repo 없거나 변경 없으면 **silent skip** (실패 아님). `--no-verify`/`--amend`/force push 절대 금지. push는 /wiki가 하지 않음 — /wiki-commit --push 별도 호출.

## 반환

stdout JSON 요약:
```json
{
  "status": "ok" | "clarify_needed" | "error",
  "source_files": ["<원 경로들>"],
  "pages_created": ["wiki/..."],
  "pages_updated": ["wiki/..."],
  "contradictions_flagged": [{"page": "...", "note": "..."}],
  "index_updated": true,
  "log_entry_written": true,
  "lint": {
    "broken_links": N,
    "missing_frontmatter": N,
    "empty_pages": N,
    "unindexed": N,
    "report_path": "wiki/lint-reports/..." | null
  },
  "validate": {
    "status": "pass" | "violations-found" | "skipped-flag" | "error",
    "violations_red": N,
    "violations_yellow": N,
    "pages_checked": N,
    "blocks_commit": true | false,
    "report_path": "wiki/lint-reports/..." | null
  },
  "commit": {
    "status": "committed" | "skipped-no-repo" | "skipped-no-changes" | "skipped-flag" | "skipped-validate-blocked" | "halted-hook-failed" | "error",
    "commit_sha": "<SHA>" | null,
    "message_subject": "<first line>" | null,
    "reason": "...(skip/halt 시 상세)" | null
  }
}
```
