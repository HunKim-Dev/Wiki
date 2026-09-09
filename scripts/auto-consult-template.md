<!-- wiki-agent auto-consult v3.0 begin -->
## LLM Wiki Auto-Consult (wiki-agent v3.0 — Hybrid mode)

이 블록은 `wiki-agent` npm 패키지가 `~/.claude/CLAUDE.md`에 주입한 것. `npm uninstall -g wiki-agent`로 marker 블록만 자동 제거.

### 동작 방식 (Hybrid)

Python hook이 결정론적 baseline 보장 + LLM이 의미 매칭으로 보강.

- Python: 키워드 매칭 후보 + 같은 그룹 모든 프로젝트 index 주입 + signals 계산
- LLM: 후보가 부정확하면 의미 매칭으로 더 나은 페이지를 직접 Read로 확보

주입 형식:
```
## [wiki-context: <org>/<project> | signals=...]

(의무 규칙 + 의미 매칭 보강 안내)

### Index — 현재 프로젝트
(현재 프로젝트 index.md 본문 최대 3KB)

### 같은 그룹 다른 프로젝트 Index — cross-project 가시화
#### [<sister-project>] index
(각 1.5KB 요약)

### Matched pages — 키워드 매칭 후보
#### `<label>` — score=N, matched=[...]
```markdown
(파일 머리 15줄 + 매칭 라인 ±5줄)
```
```

**v1.3 → v3.0 변경**: 같은 그룹 모든 프로젝트 index 주입 + 의미 매칭 보강 명시 (LLM이 후보 외 페이지도 적극 Read).

### 답변 작성 규칙 (Main Claude)

#### 1. 출처 인용 — `[[wiki-link]]` 명시 의무

답변에 매칭 wiki 페이지를 `[[concepts/<domain>/<slug>]]` 또는 `[[decisions/<id>]]` 형식으로 **반드시 1개 이상 명시 인용**. 다음은 **규칙 위반**:

❌ wiki 컨텐츠를 보고 답변했는데 소스 코드 경로(`apps/...`)만 인용하고 `[[wiki-link]]` 누락
❌ "내가 wiki를 봤다"는 사실을 답변에서 숨기고 자기 발견인 양 서술
❌ 4지선다는 출력했는데 출처 인용은 빠진 답변 (4지선다는 wiki 사용을 전제로 하므로 모순)

**올바른 형태**:

> 핵심은 [[concepts/scroll/full-page-scroll-engine]]에 정리된 5-layer guard 패턴입니다.
> 구체 구현은 `apps/main-app/app/composables/use-full-page-scroll.ts`에...

wiki 페이지 인용을 **앞**에, 소스 코드 경로를 **보조**로. 순서·우선순위 중요.

추측 금지 — wiki에 없는 정보는 "wiki에 해당 정보 없음" 명시.

#### 1-A. 의미 매칭 보강 (v3.0 신규)

Hook이 주입한 "Matched pages"는 **키워드 매칭 후보**일 뿐. 사용자 질문과 의미적으로 더 가까운 페이지가 wiki에 있을 수 있습니다.

**의미 매칭 절차**:
1. 키워드 후보 페이지가 사용자 질문과 정확히 맞는지 평가
2. 부정확하다 판단되면:
   - 현재 프로젝트 Index와 **같은 그룹 다른 프로젝트 Index**(주입돼있음) 검토
   - 동의어·다국어·추상화로 더 나은 페이지 식별
   - 그 페이지를 **`Read tool`로 직접 본문 확보**
3. 답변에는 의미적으로 가장 정확한 페이지 인용

**의미 매칭 예시**:
- 사용자 "잠금" → wiki 표현 "차단·쿨다운·body-scroll-lock"
- 사용자 "newsletter" → wiki 표현 "뉴스레터"
- 사용자 "팝업이 다른 거 가리는 거" → wiki "modal-teleport-pattern"
- 사용자 "이미지 보더 채워지는 거" → wiki "thumbnail-border-progress"

**중요**: 키워드 매칭이 약하다고 wiki 인용을 포기하지 마세요. 의미 매칭으로 적극 보강.

#### 2. signals 분기 — 자기 판단 금지

Hook header의 `signals=...` 필드를 읽고 다음 규칙 그대로 적용:

- `cross-top=<X>` → 답변 **서두**에 "현재 프로젝트 wiki에는 없어 `<X>`에서 참조합니다" 명시
- `unmapped-project=<X>:<Y>` → 답변 **말미**에 settings.json `WIKI_PROJECT_ORGS` 추가 안내
- **`precedent-likely=true` → 4지선다 표시 의무 ★**

#### 3. ⚠️ 4지선다 출력 — 두 모드 분기

##### 3-A. 모드 판별 (Hook signal 기반)

| 시그널 조합 | 모드 | 4지선다 위치 |
|---|---|---|
| `precedent-likely=true` AND `work-intent=true` | **작업 모드** | 답변 **시작** (코드 작성 전) |
| `precedent-likely=true` (work-intent 없음) | **질문 모드** | 답변 **끝** |
| `precedent-likely` 없음 | 일반 답변 | 4지선다 없음 |

##### 3-B. 작업 모드 ★ 신규 — 코드 작성 시작 전 4지선다 의무

`work-intent=true AND precedent-likely=true` 시:

**절대 규칙**:
- ❌ Edit/Write/MultiEdit 호출 금지 (사용자 응답 받기 전)
- ❌ 추측으로 새 코드 작성 금지
- ✅ 답변 **첫 줄부터** 4지선다로 시작

**출력 형식** (답변 본문 시작 부분):

````
⏸️ 잠깐 — wiki에 비슷한 게 있어요

`[[<wiki page>]]`에 <패턴 한 줄 설명>이 정리돼있습니다.

📌 과거 구현 (요약):

```<lang>
// from: <ref path>
<핵심 코드 15~30줄>
```

이대로 반영하시겠어요?

(A) 똑같이 반영 — 위 패턴 그대로 적용
(B) 부분 반영 — 다음 중 선택 (복수 가능):
    [ ] <scope item 1>
    [ ] <scope item 2>
    [ ] <scope item 3>
(C) 새로 판단 — 이번 케이스는 조건이 달라서 다른 방식 (이유 명시 권장)
(D) 참고만 — wiki는 참고하되 사용자 원래 요청대로 진행
````

**사용자 응답 후 처리**:
- (A) → wiki 페이지의 Implementation Snippet을 그대로 사용해 코드 작성
- (B) → 선택된 scope_items만 가져와 적용. 나머지는 사용자 요청대로
- (C) → 사용자 원래 요청대로 새로 작성. wiki 패턴은 참고만 (인용은 유지)
- (D) → 사용자 원래 요청대로 진행. wiki 출처는 답변 말미에 인용

##### 3-C. 질문 모드 (기존 — 변경 없음)

**트리거 조건**: `precedent-likely=true` AND work-intent 없음

답변 본문 작성 → 끝에 4지선다 표시.
- "어떻게 구현했어?" / "어떻게 만들어?" → 트리거
- "X가 뭐야?" / "A와 B 관계?" → 생략 가능

**금지 사항** (LLM이 자주 빠지는 함정):
- ❌ "정보성 질문이라 4지선다 부적절"이라 자기 판단으로 생략
- ❌ "사용자가 짧게 묻길 원할 듯"이라 자기 판단으로 생략
- ❌ 답변이 길어진다고 4지선다 누락
- ❌ 코드 스니펫이 없다고 4지선다도 같이 누락 (스니펫만 빼고 4지선다는 출력)

**정확한 출력 포맷** — 답변 본문 뒤에 그대로:

````
📌 과거 구현 (요약):

```<lang>
// from: <매칭 페이지 경로>
<페이지의 코드 블록에서 핵심 15~30줄 추출. 코드 블록 없으면 이 섹션 전체 생략>
```

이 패턴을 어떻게 처리하시겠어요?

(A) 똑같이 반영 — <kind별 표현>
(B) 부분 반영 — 다음 중 선택 (복수 가능):
    [ ] <항목 1 — 매칭 페이지 본문에서 의미 단위로 추출>
    [ ] <항목 2>
    [ ] <항목 3>
(C) 새로 판단 — 조건이 달라서 재설계
(D) 참고만 — 반영 없음, 정보만

승인 시 `/wiki-resolve`로 이어갑니다 (실 파일 수정 전 dry-run 필수).
````

**(A) 표현 가이드** (매칭 페이지 종류에 따라):
- `decisions/*.md` 매칭 → "과거 결정 그대로 적용"
- `actions/*.md` 매칭 → "과거 해소 방식 그대로 적용"
- `concepts/*.md` 또는 `entities/*.md` 구현 패턴 매칭 → "위 패턴 그대로 구현"

#### 4. 🔴/⚠️ 플래그 보존

매칭 페이지에 🔴 모순·⚠️ 미해결 이슈 있으면 **반드시** 답변에 포함. 숨김·축소 금지.

### 새 지식 저장 제안

다음 3조건 모두 만족 시 답변 말미에 저장 제안 추가:
1. Hook 주입한 wiki 컨텐츠가 질문 주제를 정확히 다루지 않음 (매칭 페이지가 주변부)
2. 답변 작성에 Agent/Bash/Read로 코드·외부 분석 수행
3. 답변이 재사용 가치 있는 합성·인사이트 포함

```
이 내용은 wiki에 없는 새 지식입니다. `/wiki`로 영구 기록할까요?
제안 경로: wiki/<kind>/<domain>/<slug>.md
  - kind: concept | entity | decision 중 선택
  - domain: 현재 프로젝트 기존 도메인 중 선택, 없으면 신규 제안
```

### 해결된 문제 저장 제안 — 주제 전환 감지

다음 3가지 AND:
1. 직전 응답에 Edit/Write/MultiEdit으로 코드 수정
2. 현재 프롬프트가 주제 전환 또는 짧은 감사 ("ok", "thx", "좋아")
3. 실패 신호 없음 (안 돼·에러·여전히·error·still·fail 부재)

→ 답변 초반에:
```
📝 직전에 <주제> 해결한 내용을 wiki에 저장할까요?
   - 문제: <한 줄>
   - 해결: <어떻게>
   - 제안 경로: wiki/<kind>/<domain>/<slug>.md
```

**제안 금지 케이스**:
- 단순 typo·한 글자 수정
- 같은 파일 내 연속 수정 진행 중
- 사용자가 방금 같은 주제 저장 거부 직후

### Skip 조건 (Hook directive 무시)

다음 중 하나라도 해당:
- 사용자 명시 거부: "위키 참조하지 마", "그냥 답해", "skip wiki"
- 비-기술 메타 질문 (CLI 안내·환경 설정·인사)
- 단순 파일 한 줄 조회·라인 번호 확인

### 저장 정책

Hook·auto-consult는 **읽기 전용**. 새 wiki 페이지를 자동 생성하지 않음. 저장은 `/wiki "..."` 명시 호출. 실 파일 변경은 `/wiki-resolve`.

### Kill Switch

- 임시 비활성: `export WIKI_AUTOCONSULT=0`
- Strict 격리 (현재 프로젝트만): `export WIKI_SCOPE=current`
- 영구 제거: `npm uninstall -g wiki-agent`
<!-- wiki-agent auto-consult v3.0 end -->
