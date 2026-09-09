---
name: wiki-lint
description: wiki 건강 상태를 비파괴적으로 점검하고 리포트 생성. 경량(깨진 링크·빈 페이지·frontmatter) + 전체(고아·오래된·의미모순). 자동 수정 없음, 리포트만. 평소 기록은 /wiki가 경량 lint를 자동 포함하므로 본 스킬은 **주기적 전체 점검** 또는 **수동 체크** 전용.
---

# /wiki-lint — 독립 점검 (escape hatch)

`/wiki`(기록 스킬)가 이미 경량 점검을 자동 수행한다. 본 스킬은 다음 경우에만 호출:
- 주기적 전체 점검 (2~4주 간격, `--mode full`)
- 기록 없이 순수하게 건강 상태만 확인
- `/wiki` 실행 후 더 깊은 분석이 필요할 때

## 역할 경계

- **자동 수정 금지**. 문제 발견 시 리포트만. 수정은 수동 또는 `/wiki-resolve`.
- **리포트 외 파일 생성 금지**. wiki 페이지 자체 건드리지 않음.
- 🔴/🟡/🟢 분류로 심각도 표시.

## 경로 해석 — Org / Project 2단계 모델

`/wiki`와 동일한 규칙:
- `$WIKI_PATH` / `$WIKI_PROJECT_ORGS` / `$WIKI_DEFAULT_ORG`는 `~/.claude/settings.json`에서 자동 주입
- 프로젝트명 = cwd의 git root basename (fallback: cwd basename)
- Org = `WIKI_PROJECT_ORGS` 명시 매핑 → `WIKI_DEFAULT_ORG` 폴백
- 출력 루트 `$OUT = $WIKI_PATH/$ORG/$PROJECT`
- 본문의 `wiki/...`는 `$OUT/` 기준

실행 전 확인:
1. `$WIKI_PATH` 설정 + 실존 디렉토리
2. cwd가 엔진 레포(`$WIKI_ENGINE_ROOT`)가 아님
3. `$OUT/wiki/` 없으면 "wiki 없음" 리포트로 조기 종료 (기록이 아직 없으므로 점검할 것도 없음)

조건 실패 시 중단 메시지 출력 후 종료.

## 입력 파라미터

- `--mode <lightweight|full>` (기본 lightweight)
- `--save-report <bool>` (기본 true; false면 stdout만)

## 두 가지 모드

### 경량 (`lightweight`)

구조적 점검만 (결정론적, LLM 불필요):
- 깨진 `[[wiki-link]]` 탐지
- index.md 누락 항목 (wiki에 있지만 등록 안 된 페이지)
- 빈 페이지 (frontmatter만 있고 본문 100바이트 미만)
- 신규 페이지의 교차 참조 누락
- frontmatter 필수 필드 누락 (`id`, `kind`, `source`, `updated`)

목표 시간: 30초~1분.

### 전체 (`full`)

경량 + 다음 의미 점검:
- **고아 페이지** — 어느 페이지에서도 링크되지 않은 페이지
- **오래된 페이지** — frontmatter `updated` 기준 90일 경과
- **과도한 중복** — 같은 개념이 여러 페이지에 중복 기술
- **Forward reference** — wiki에서 언급되지만 페이지 없는 개념
- **의미적 모순** (LLM) — 페이지 간 내용 충돌 (상위 20페어까지)

목표 시간: 5~10분.

## 처리 흐름

1. **입력 검증** + `wiki/index.md` 존재 확인. 없으면 "wiki 없음" 리포트로 조기 종료.
2. **페이지 목록 수집**: `Glob wiki/**/*.md` (recursive — 도메인 서브디렉토리 자동 포함). 제외: `wiki/actions/**`, `wiki/clarifications/**`, `wiki/log.md`, `wiki/lint-reports/**`.
3. **도메인 구조 감지**: `wiki/concepts/*/` 와 `wiki/entities/*/` 하위 서브디렉토리 목록화. 각 도메인의 페이지 수를 리포트 🟢 섹션에 포함. decisions/는 도메인 분할 없음.
3. **구조적 점검** (경량 핵심):
   - 각 페이지의 `[[link]]` 추출 → 대상 파일 존재 확인 (Glob/Read)
   - index.md 등록 항목 vs 실제 페이지 목록 비교
   - frontmatter 필드 검증 (Read + 파싱)
   - 빈 페이지 탐지 (파일 크기 + 내용 확인)
4. **의미 점검** (전체 모드만):
   - 고아: 각 페이지 in-link 수 카운트 (전체 그랩 후 역인덱스)
   - 오래된: `updated` 파싱 → `today - 90d` 이전이면 표시
   - 의미 모순: index.md 기반 연관 페이지 그룹핑 후 페어별 내용 비교. 토큰 예산상 상위 20페어까지만.
5. **리포트 생성**: 아래 템플릿, 🔴/🟡/🟢 분류.
6. **저장**: `save-report: true`면 `wiki/lint-reports/<YYYY-MM-DD>-<mode>.md`.

## 리포트 템플릿

```markdown
---
id: lint-report/<date>-<mode>
kind: lint-report
title: Wiki Lint Report — <date> (<mode>)
created: <ISO-8601>
trigger: <schedule|manual>
mode: <lightweight|full>
---

# Wiki Lint Report — <date>

- 모드: <lightweight|full>
- 스캔 페이지: <N>
- 소요 시간: <N>초

## 🔴 즉시 해결 필요

### 깨진 링크 (<count>)
- `wiki/concepts/events/X.md:L23` → `[[concepts/i18n/Y]]` 대상 없음
- `wiki/entities/events/X.md:L45` → `[[concepts/auth/Z]]` 대상 없음 (도메인 경로 포함)

### frontmatter 필수 필드 누락 (<count>)
- `wiki/X.md` — `source` 필드 없음

### 빈 페이지 (<count>)
- `wiki/X.md` (78 bytes)

## 🟡 검토 권장

### index.md 미등록 (<count>)
- `wiki/concepts/events/new-thing.md`

### 오래된 페이지 (90d+, <count>) — full 전용
- `wiki/concepts/events/X.md` — 2025-11-20 (155일 전)

### 고아 페이지 (<count>) — full 전용
- `wiki/concepts/ui/X.md`

### 의미 모순 후보 (<count>) — full 전용
- `wiki/concepts/i18n/A.md` vs `wiki/concepts/events/B.md` — <LLM 요약>

## 🟢 정상

- 링크 무결성: <OK | N개 문제>
- frontmatter: <OK | N개 누락>
- 교차 참조 평균: <N>개/페이지
- 도메인 분포: `<domain1>: <N>` / `<domain2>: <M>` / ... / decisions: <K>  (프로젝트 택소노미별)

## 다음 행동 제안

- 깨진 링크는 `/wiki`로 누락 페이지 생성 또는 링크 수정
- 오래된 페이지는 소스 재-ingest 또는 삭제 결정
- 의미 모순은 `/wiki-resolve`로 후속 해결
```

## 엄격한 규칙

- **자동 수정 금지**.
- **리포트 외 wiki 파일 수정 금지**.
- 🔴는 즉시 해결 가치 있는 것만 (깨진 링크, frontmatter 누락, 빈 페이지).
- 🟡는 검토 권장 (오래된, 고아, 의미 모순).
- 🟢에 **항상 수치 포함** — 베이스라인 제공.
- `wiki/lint-reports/` 디렉토리는 필요 시 생성.
- 엔진 레포(`$WIKI_ENGINE_ROOT`) 수정 금지.

## 반환

stdout JSON:
```json
{
  "status": "ok" | "error",
  "mode": "lightweight" | "full",
  "pages_scanned": N,
  "broken_links": N,
  "missing_frontmatter": N,
  "empty_pages": N,
  "unindexed": N,
  "orphans": N,
  "stale_pages": N,
  "semantic_conflicts": N,
  "report_path": "wiki/lint-reports/..." | null,
  "elapsed_ms": N
}
```
