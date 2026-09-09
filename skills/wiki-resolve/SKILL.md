---
name: wiki-resolve
description: 판례(과거 결정/액션) 또는 🔴 플래그를 근거로 **실제 파일·wiki 변경**을 수행. 5단계 플로우 — Context, Choice, Plan preview, Apply, Verify. Stage 3·4 사용자 승인 필수. 사용자가 "이거 적용해", "판례대로 반영", "C01 해결", "/wiki-resolve"라고 말할 때 호출.
---

# /wiki-resolve

그럼

## 언제 실행하나

- `wiki-query`·auto-consult가 **판례 탐지** + 4지선다 제시한 직후 사용자가 A/B/C를 선택했을 때
- 사용자가 직접 "🔴 C01 해결해", "이거 판례대로 적용"처럼 요청할 때
- 🔴 플래그 단건을 타겟으로 해소하고 싶을 때

## 언제 쓰면 안 되는가

- **단순 질문**: 읽기만 원하면 `/wiki-query`로 충분
- **읽기 전용 정보 확인**: auto-consult가 이미 답변 — 굳이 이 스킬 필요 없음
- **범위를 벗어난 대규모 리팩토링**: 본 스킬은 판례/플래그 단위 해소용. 대형 변경은 사람 주도 + 여러 `/wiki-resolve` 호출로 쪼개기

## 실행 절차

1. **입력 파악**: 사용자 메시지에서 타겟 식별
   - 판례 ID (예: `decisions/ADR-001` + 선택 A/B/C)
   - 플래그 ID (예: `C01`)
   - 자유 텍스트 의도 (예: "JWT HS256을 RS256으로")
2. **경로 해석**:
   - 소스 (`$WIKI_TARGET_REPO`): 환경변수 → `--target` → cwd (소스 파일 수정 대상)
   - 출력 (`$WIKI_OUTPUT_DIR`): 환경변수 → `--output` → `$WIKI_TARGET_REPO` 폴백 (wiki/ 파일 저장 대상)
3. **엔진 레포 안전 가드**: `$WIKI_TARGET_REPO` 또는 `$WIKI_OUTPUT_DIR` 어느 쪽이든 `$WIKI_ENGINE_ROOT`(이 패키지의 소스 트리) 하위면 중단 (두 경로 모두 검사)
4. `Task` 도구로 `wiki-resolve` 서브에이전트 호출. 위 입력 전달.
5. 서브에이전트가 5단계 수행:
   - Stage 1: Context 파악 + pre_change_commit 기록
   - Stage 2: Choice 확인 (필요 시 재질문)
   - Stage 3: **Plan preview** — 계획서 초안(`wiki/actions/<slug>.md`) + 사용자 승인 대기
   - Stage 4: **Apply** — 승인된 경우에만 실 파일 수정
   - Stage 5: Verify — 변경 요약 + rollback 경로
6. 주 Claude가 결과 요약 제시:
   - 적용된 파일 목록
   - 🔴 → 🟡 전환 플래그
   - rollback 명령
   - 수동 후속 작업(키 생성 등)

## 엄격한 규칙

- **Stage 3 "이대로 적용?" 프롬프트에서 y 없이는 실 파일 수정 금지**. 서브에이전트가 이 규칙 위반 시 즉시 중단.
- **수정 범위 MVP**:
  - ✅ 소스 파일
  - ✅ wiki/ 파일
  - ❌ 키·시크릿 생성
  - ❌ Bash 명령 실행 (빌드·테스트·배포) — git status/diff 읽기만
- **Scope lock**: 계획서 `files_to_change` 목록에 없는 파일 수정 금지. 범위 새면 `halted-scope-violation`.
- **pre_change_commit 기록**: rollback 경로 보장.
- **자연어·슬래시 양쪽 허용**: 사용자가 "판례대로 적용해줘"라고 해도 Stage 3 관문은 **무조건** 통과.
- 이미 `applied` 상태 액션은 재실행 금지. 필요 시 새 slug.

## 출력 위치

이 스킬은 유일하게 소스와 출력 양쪽에 쓴다:

- `$WIKI_OUTPUT_DIR/wiki/actions/<YYYY-MM-DD>-<slug>.md` (미설정 시 `$WIKI_TARGET_REPO`로 폴백, 계획서 + 상태 기록)
- `$WIKI_OUTPUT_DIR/wiki/decisions/...`, `wiki/concepts/...`, `wiki/entities/...` 등 wiki 파일
- `$WIKI_OUTPUT_DIR/wiki/index.md` — 진행 중 섹션 업데이트, 🔴 → 🟡 전환
- `$WIKI_OUTPUT_DIR/wiki/log.md` — resolve 이력 append
- `$WIKI_TARGET_REPO/src/...` 등 소스 파일 — **소스 수정은 `$WIKI_TARGET_REPO`에만** (예외적 쓰기)

## 예시 플로우 (JWT C01 해결)

```
사용자: "JWT 판례대로 적용해줘"
  ↓
/wiki-resolve 호출 → 서브에이전트 기동
  ↓
Stage 1: ADR-001 + C01 맥락 파악, pre_change_commit 기록
Stage 2: "A로 확정? (예전 RS256 그대로)" → 사용자 y
Stage 3: 계획서 초안 (status: proposed) + diff 미리보기
         "이대로 적용? (y/n/edit)" → 사용자 y
Stage 4: src/auth/token.py 수정 + wiki 5개 파일 업데이트
         계획서 status: applied
Stage 5: 요약 + rollback 명령 + 수동 후속 안내 (RSA 키 생성 등)
```
