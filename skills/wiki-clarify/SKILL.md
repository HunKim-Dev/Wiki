---
name: wiki-clarify
description: 다른 스킬(/wiki, /wiki-resolve) 실행 중 맥락이 부족할 때 사람에게 최대 3개의 핵심 질문으로 확인받는다. 답변은 wiki/clarifications/에 저장. 주로 다른 스킬이 내부 호출하지만, 사용자가 특정 Q&A를 미리 기록하고 싶을 때 직접 호출 가능.
---

# /wiki-clarify — 맥락 확인 헬퍼

다른 스킬이 작업 중 맥락이 부족할 때 사람에게 **최소한의 핵심 질문**으로 확인. 답변을 저장해 후속 재사용.

## 호출 맥락

- `/wiki`가 ingest 중 모호한 용어·약어·결정 근거 부재를 만났을 때
- `/wiki-resolve`가 판례 선택의 scope가 불명확할 때
- 사용자가 직접 호출 — Q&A 쌍을 미리 기록

## 경로 해석 — Org / Project 2단계 모델

`/wiki`와 동일한 규칙: `$WIKI_PATH` + org + project. `$OUT = $WIKI_PATH/$ORG/$PROJECT`. `wiki/clarifications/`는 `$OUT/wiki/clarifications/`. Org 해석은 `/wiki` SKILL.md 참조.

실행 전 확인:

1. `$WIKI_PATH` 설정 + 실존 디렉토리
2. cwd가 엔진 레포(`$WIKI_ENGINE_ROOT`) 아님

## 입력

호출자가 다음을 전달:

- `current_skill`: 호출한 스킬명 (manual 호출 시 "manual")
- `current_task`: 현재 작업 한 줄 설명
- `missing_context`: 구체적으로 무엇이 불명확한지 (리스트)

## 처리 흐름

1. **불확실성 분석**: `missing_context`를 읽고 가장 결정적인 정보 1~3개로 압축.
2. **질문 생성 규칙**:
   - **최대 3개**, 초과 금지
   - 가장 불확실한 것 먼저
   - 각 질문 앞에 **왜 필요한지 한 줄 맥락** 부착
   - 예/아니오보다 **구체적 정보 요청** 우선
   - 답하기 쉽게 — 서술형 말고 짧은 답 가능하게
3. **사용자 질문 제시** 포맷:

```
[wiki-clarify 발동]
현재 작업: <current_skill> — <current_task>

다음 정보가 필요합니다:

1. <질문1>
   (맥락: <왜 필요한지>)

2. <질문2>
   (맥락: ...)

답변 후 원 작업을 계속 진행합니다.
```

4. **답변 저장**: 사용자가 답하면 `wiki/clarifications/<YYYY-MM-DD>-<context-slug>.md`에 저장:

```markdown
---
id: clarification/<YYYY-MM-DD>-<slug>
kind: clarification
title: <맥락 한 줄 요약>
source: <triggered_by 스킬 — 예: wiki, manual>
created: <ISO-8601>
updated: <ISO-8601>
tags: []
---

## 질문과 답변

### Q1. <질문1>

**맥락**: <왜>
**답**: <사용자 답>

### Q2. ...
```

5. **호출 스킬로 반환**: 답변을 구조화해 돌려주고, wiki에 반영이 필요하면 `/wiki` 후속 호출을 추천 (즉시 저장은 하지 않음 — 기록 책임은 /wiki에 있음).

## 엄격한 규칙

- **질문 최대 3개**. 초과 시 사용자 피로 증가.
- 각 질문에 **맥락 한 줄 필수**.
- 모순이 감지되면 반드시 질문 (추론 금지).
- 답변 파일명은 `wiki/clarifications/<날짜>-<슬러그>.md` (충돌 시 `-1`, `-2`).
- 답변 저장 후 곧바로 다른 wiki 페이지에 반영하지 않는다 — 반영은 `/wiki`의 책임.
- 엔진 레포(`$WIKI_ENGINE_ROOT`) 수정 금지.

## 반환

stdout JSON:

```json
{
  "status": "answered" | "skipped" | "error",
  "questions_asked": N,
  "answers": [{"q": "...", "a": "..."}],
  "answer_file": "wiki/clarifications/...",
  "follow_up": "/wiki 추천" | "none"
}
```
