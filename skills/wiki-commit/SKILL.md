---
name: wiki-commit
description: $WIKI_PATH(위키 저장소)의 변경사항을 git으로 커밋. log.md에서 최근 ingest 요약을 추출해 자동 commit message 생성, 사용자 승인 후 적용. 선택적으로 push. 소스 레포는 절대 건드리지 않음. "/wiki-commit", "위키 커밋", "wiki 저장", "wiki 커밋해줘"라고 말할 때.
---

# /wiki-commit — wiki 저장소 git 커밋

`$WIKI_PATH`에 쌓인 wiki 페이지를 **한 묶음으로 git commit**한다. 소스 레포(`$SRC`)는 **절대 건드리지 않음** — 본 스킬의 작업 루트는 오직 `$WIKI_PATH`.

## 언제 사용

- `/wiki` 기록을 여러 번 쌓은 뒤 주기적으로 git 반영
- 팀과 공유하기 전 커밋 정리 (+ `--push`로 업스트림 반영)
- 백업 목적으로 일정 간격 자동 스냅샷

## 경로 해석

- **작업 루트**: `$WIKI_PATH` (settings.json에서 자동 주입된 경로, 예: `/Users/grove/WorkSpace/wiki4docs`)
- **엔진 레포 가드**: `$WIKI_PATH`가 `/Users/grove/WorkSpace/wiki3` 또는 `/Users/grove/WorkSpace/wiki4`이면 **즉시 중단**. 엔진 자체를 커밋하지 않는다.
- `$SRC` (소스 레포)는 읽지도 쓰지도 않는다 — 심지어 cwd가 소스 레포여도 git 명령은 `-C $WIKI_PATH`로 강제.

## 인자

| 인자 | 기본 | 설명 |
|---|---|---|
| (없음) | — | 자동 메시지 생성 + 대화형 승인 |
| `--message "..."` | — | 자동 생성 대신 직접 메시지 지정 |
| `--push` | false | 커밋 후 push까지 (upstream 설정돼 있을 때만) |
| `--no-confirm` | false | 비대화형 실행 (스케줄러/CI용, 신중히) |

## 실행 절차

### 1. Git repo 상태 확인

```bash
cd "$WIKI_PATH"
# 엔진 레포 가드
case "$WIKI_PATH" in
  /Users/grove/WorkSpace/wiki3*|/Users/grove/WorkSpace/wiki4*)
    echo "HALT: engine repo — refuse"; exit 1 ;;
esac
# git repo 여부
[ -d .git ] || { echo "NOT_A_GIT_REPO"; exit 0; }
# 상태 수집
git -C "$WIKI_PATH" status --short
git -C "$WIKI_PATH" log -1 --format="%H %s" 2>/dev/null || echo "NO_COMMITS_YET"
```

git repo 아니면 사용자에게 다음 안내 후 종료 (자동 init 하지 않음 — 위키 데이터 저장소라 신중해야 함):

```
$WIKI_PATH 는 git repo가 아닙니다.

수동 초기화 권장:
  cd $WIKI_PATH
  git init
  git add .
  git commit -m "initial wiki"
  # (선택, 팀 공유하려면) git remote add origin <url>

자동 init은 지원하지 않습니다 (사용자 확인 없이 git 상태를 만들지 않음).
```

### 2. 변경 분석

```bash
git -C "$WIKI_PATH" status --short    # 변경 파일 목록
git -C "$WIKI_PATH" diff --stat HEAD  # 각 파일 byte 변화 (HEAD 있을 때)
```

커밋할 게 없으면 (`git status --short` 출력 비어있음) 즉시 종료:
```
변경 없음. 이미 모두 커밋돼 있습니다.
현재 HEAD: <SHA> — <subject>
```
status: `nothing-to-commit` 반환.

### 3. Commit message 자동 생성

`--message`가 **명시되지 않은 경우에만** 수행.

각 프로젝트(`$WIKI_PATH/*/wiki/log.md`)의 로그에서 **마지막 git commit 이후 추가된 ingest entries**를 추출:

```bash
LAST_COMMIT=$(git -C "$WIKI_PATH" log -1 --format=%H 2>/dev/null)
for logf in "$WIKI_PATH"/*/wiki/log.md; do
  proj=$(basename "$(dirname "$(dirname "$logf")")")
  if [ -n "$LAST_COMMIT" ]; then
    # 마지막 커밋 이후 log.md에 추가된 줄
    git -C "$WIKI_PATH" diff "$LAST_COMMIT" -- "$(realpath --relative-to="$WIKI_PATH" "$logf")" | grep '^+' | grep -v '^+++' | sed 's/^+//'
  else
    cat "$logf"
  fi
done
```

ingest entries(`[ISO] ingest:`)만 골라 메시지 조립:

```
wiki: <YYYY-MM-DD> — <N>개 ingest (<project A count>+<project B count>)

<project A>:
  - [2026-04-23T12:00:00Z] ingest: Xeno Point Challenge 작업 히스토리 → concepts 2개 신규 + entity 1 update
  - [2026-04-23T14:30:00Z] ingest: Stellar Blade 로그인 재시도 UX → ...

<project B>:
  - [2026-04-23T15:00:00Z] ingest: ...

🤖 Generated with /wiki-commit
```

인자로 `--message "..."`가 주어졌으면 자동 생성 건너뛰고 그대로 사용. `🤖 Generated` 꼬리는 붙이지 않음.

### 4. 사용자 승인 (`--no-confirm` 없을 때)

다음 형식으로 제시:

```
다음 커밋을 수행할까요?

[메시지]
wiki: 2026-04-23 — 2개 ingest (pubgcom-app-front 2)

pubgcom-app-front:
  - [...] ingest: ...
  - [...] ingest: ...

🤖 Generated with /wiki-commit

[변경 파일 — 7개]
 M pubgcom-app-front/wiki/entities/xenopointchallenge-event.md   (+1228 bytes)
 M pubgcom-app-front/wiki/index.md                                (+349 bytes)
 M pubgcom-app-front/wiki/log.md                                  (+282 bytes)
?? pubgcom-app-front/wiki/concepts/hoverable-device-xbox-gap.md   (신규)
?? pubgcom-app-front/wiki/concepts/xenopoint-hardcoded-event-period.md (신규)

(y: 커밋 진행 / n: 취소 / edit: 메시지 수정)
```

- `y` — Stage 5 진행
- `n` — 종료, 파일 그대로 유지
- `edit` — 메시지 수정 받아 재확인

### 5. Commit 실행 (y 승인 후에만)

```bash
git -C "$WIKI_PATH" add -A
git -C "$WIKI_PATH" commit -m "$(cat <<'EOF'
<message>
EOF
)"
NEW_SHA=$(git -C "$WIKI_PATH" rev-parse HEAD)
```

- `--no-verify` **절대 사용 금지** — pre-commit hook 있으면 따른다.
- `--amend` **금지** — 항상 새 commit.

pre-commit hook 실패 시: 실패 이유를 사용자에게 보고하고 **중단**. 훅 우회하지 않음.

### 6. Push (`--push` 주어진 경우만)

```bash
# upstream 확인
UPSTREAM=$(git -C "$WIKI_PATH" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)
```

- 없으면 사용자에게:
  ```
  upstream 미설정 — push 수동으로 진행해주세요:
    cd $WIKI_PATH
    git branch --set-upstream-to=origin/<branch>
    git push
  ```
  `pushed: false` 반환.

- 있으면:
  ```bash
  git -C "$WIKI_PATH" push
  ```
  **`--force`, `--force-with-lease` 절대 금지**. push 실패 시(ff-not-possible, remote rejected 등) 에러 전파 + 수동 해결 안내.

### 7. Verify + 보고

```
✅ 커밋 완료

SHA: <NEW_SHA>
메시지: <첫 줄>
변경 파일: <N>
push: <yes/no/skipped>
upstream: <origin/main or null>

다음 단계:
  - 웹에서 확인: <remote URL if available>
  - 취소: git -C $WIKI_PATH reset --soft HEAD^   # (사용자 수동)
```

## 엄격한 규칙

- **`$SRC` 절대 건드리지 않음** — git 명령은 전부 `-C $WIKI_PATH` 강제
- **자동 `git init` 금지** — 사용자 수동 수행
- **Force push 금지** — `--force`, `--force-with-lease` 지원 안 함
- **`--no-verify` 금지** — pre-commit hook 있으면 따름
- **`--amend` 금지** — 항상 새 commit
- **Engine repo guard** — `$WIKI_PATH`가 wiki3/wiki4 계열이면 중단
- **사용자 승인 필수** — `--no-confirm` 플래그 없으면 y 입력 전까지 Stage 5 진입 금지
- **pre-commit hook 실패 시 우회 금지** — 실패 원인 보고 후 중단, `--no-verify`로 뚫지 않음
- 민감 파일(`.env`, credentials, 큰 바이너리) 감지 시 경고만 하고 사용자 확인

## 반환

stdout JSON:
```json
{
  "status": "committed" | "nothing-to-commit" | "not-a-repo" | "halted-user-rejected" | "halted-hook-failed" | "halted-engine-repo" | "error",
  "commit_sha": "<SHA>" | null,
  "commit_message_subject": "<first line>",
  "files_changed": N,
  "new_files": N,
  "modified_files": N,
  "pushed": true | false,
  "upstream": "origin/main" | null,
  "message_auto_generated": true | false
}
```
