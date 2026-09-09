#!/usr/bin/env python3
"""
wiki-for-claude Stop hook — 답변 인용 V1+V2 검증.

목적: Claude가 답변에서 wiki 인용 정책을 지켰는지 확인.

검증 항목:
  V1 (깨진 인용): 답변의 [[wiki-link]]가 실제 wiki 파일을 가리키는가
  V2 (인용 누락): wiki context 받았는데 [[ ]] 0건은 아닌가 (anti-hallucination 직격)

동작:
  1. transcript 마지막 assistant 메시지 추출
  2. 길이 <100자 = 잡담, skip
  3. [[...]] 정규식 추출
  4. 인용 0건 + wiki context 주입됐었음 → V2 위반 → stderr
  5. 인용 있음 → 각각 resolve → 깨진 거 있으면 V1 위반 → stderr
  6. 모두 통과 시 조용히 종료

V2 판정 근거: ~/.claude/hooks/wiki-auto-consult.tsv 마지막 줄에서
  event=injected AND matched_count > 0 이면 wiki context가 주입됐다고 봄.

핵심: Python 결정론. claude subprocess·LLM 호출·파일 저장 없음. 토큰 비용 0.

가드:
  - WIKI_CITE_VERIFY=0 시 즉시 종료 (kill switch)
  - 엔진 레포(이 패키지 자신) 안에서는 종료
  - transcript 없거나 답변 짧으면 종료

실패 시 항상 exit 0.
"""

import os
import sys
import json
import re
import glob

HOME = os.path.expanduser("~")
SETTINGS = os.path.join(HOME, ".claude", "settings.json")


def load_env():
    """settings.json env + os.environ 병합."""
    merged = dict(os.environ)
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            for k, v in (json.load(f).get("env", {}) or {}).items():
                if v: merged[k] = v
    except Exception:
        pass
    return merged


def extract_last_assistant(transcript_path):
    """JSONL transcript에서 마지막 assistant 메시지 텍스트 추출."""
    try:
        with open(transcript_path, encoding="utf-8") as f:
            messages = [json.loads(l) for l in f if l.strip()]
    except Exception:
        return ""
    for m in reversed(messages):
        if m.get("role") != "assistant":
            continue
        content = m.get("content", "")
        # Claude Code transcript는 content가 string 또는 list-of-dicts (text/tool_use)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"
            )
    return ""


def find_wiki_roots(env, cwd):
    """현재 프로젝트 wiki + 같은 그룹 다른 프로젝트 wiki 경로 목록."""
    wiki_path = env.get("WIKI_PATH", "")
    if not wiki_path or not os.path.isdir(wiki_path):
        return []

    # 프로젝트 감지
    import subprocess
    try:
        src = subprocess.check_output(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL, timeout=2,
        ).decode().strip()
    except Exception:
        src = cwd
    project = os.path.basename(src)

    # org 결정 (간단 버전: WIKI_PROJECT_ORGS or WIKI_DEFAULT_ORG)
    project_orgs = {}
    for pair in env.get("WIKI_PROJECT_ORGS", "").split(","):
        if "=" in pair:
            k, v = pair.strip().split("=", 1)
            project_orgs[k.strip()] = v.strip()
    org = project_orgs.get(project) or env.get("WIKI_DEFAULT_ORG", "")
    if not org:
        return []

    # 현재 프로젝트 + 같은 org의 모든 sister 프로젝트 wiki 루트 수집
    roots = []
    current_root = os.path.join(wiki_path, org, project, "wiki")
    if os.path.isdir(current_root):
        roots.append((project, current_root))
    org_dir = os.path.join(wiki_path, org)
    if os.path.isdir(org_dir):
        for proj in sorted(os.listdir(org_dir)):
            if proj == project: continue
            sis_root = os.path.join(org_dir, proj, "wiki")
            if os.path.isdir(sis_root):
                roots.append((proj, sis_root))
    return roots


def resolve_citation(citation, wiki_roots):
    """인용을 wiki 파일로 resolve. (project, path) 또는 None."""
    # cross-project: [[project:concepts/x]]
    target_project = None
    rel = citation
    if ":" in citation:
        target_project, rel = citation.split(":", 1)

    # path form (concepts/...) vs id form (concept/...)
    candidates = [f"{rel}.md"]
    if rel.startswith(("concept/", "entity/")):
        plural = "concepts/" if rel.startswith("concept/") else "entities/"
        candidates.append(plural + rel.split("/", 1)[1] + ".md")

    for proj, root in wiki_roots:
        if target_project and proj != target_project:
            continue
        for cand in candidates:
            if os.path.isfile(os.path.join(root, cand)):
                return (proj, cand)
    return None


def was_wiki_context_injected():
    """V2 판정용: 직전 UserPromptSubmit에서 wiki context 주입됐었는지.

    ~/.claude/hooks/wiki-auto-consult.tsv 마지막 줄 보고:
      event=injected AND matched_count > 0 이면 True.
    그 외 (skip-* 또는 매칭 0개)는 False — V2 검증 skip.
    """
    tsv = os.path.join(HOME, ".claude", "hooks", "wiki-auto-consult.tsv")
    try:
        with open(tsv, encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) < 2:  # 헤더만
            return False
        # 컬럼: timestamp, event, project, org, org_method, prompt_len,
        #       top_score, top_match, matched_count, keywords_top5
        cols = lines[-1].rstrip("\n").split("\t")
        if len(cols) < 9:
            return False
        if cols[1] != "injected":
            return False
        return int(cols[8]) > 0
    except Exception:
        return False



# ───── 엔진 레포 가드 (이식 가능) ─────
#
# 이 패키지 자신의 소스 트리 안에서는 자기 자신을 wiki로 참조하지 않는다.
# 1순위: install.js가 settings.json env에 넣어준 WIKI_ENGINE_ROOT
# 2순위: cwd에서 위로 올라가며 엔진 마커 파일 탐색 (env 없이 직접 실행한 경우)

ENGINE_MARKER = os.path.join("scripts", "hooks", "wiki-auto-consult.py")


def is_engine_repo(path_str):
    if not path_str:
        return False
    try:
        target = os.path.realpath(path_str)
    except Exception:
        return False

    root = os.environ.get("WIKI_ENGINE_ROOT", "")
    if root:
        try:
            root = os.path.realpath(root)
            if target == root or target.startswith(root + os.sep):
                return True
        except Exception:
            pass

    cur = target
    while True:
        if os.path.isfile(os.path.join(cur, ENGINE_MARKER)):
            return True
        parent = os.path.dirname(cur)
        if parent == cur:
            return False
        cur = parent


def main():
    env = load_env()

    # Kill switch
    if env.get("WIKI_CITE_VERIFY") == "0":
        sys.exit(0)

    # 입력
    try:
        event = json.loads(sys.stdin.read())
    except Exception:
        sys.exit(0)
    cwd = event.get("cwd", os.getcwd())
    transcript = event.get("transcript_path")

    # 엔진 레포 가드
    if is_engine_repo(cwd):
        sys.exit(0)
    if not transcript or not os.path.isfile(transcript):
        sys.exit(0)

    text = extract_last_assistant(transcript)
    if not text:
        sys.exit(0)

    # 짧은 답변 = 잡담. V1·V2 모두 skip
    if len(text) < 100:
        sys.exit(0)

    citations = re.findall(r"\[\[([^\]]+)\]\]", text)

    # V2: 인용 누락 검사 — wiki context 받았는데 [[ ]] 0건이면 정책 위반
    if not citations:
        if was_wiki_context_injected():
            print("⚠️ wiki4: wiki 컨텍스트 받았는데 [[wiki-link]] 인용 0건 — 정책 위반",
                  file=sys.stderr)
        sys.exit(0)

    # V1: 깨진 인용 검사
    wiki_roots = find_wiki_roots(env, cwd)
    if not wiki_roots:
        sys.exit(0)

    broken = []
    for c in citations:
        if resolve_citation(c, wiki_roots) is None:
            broken.append(c)

    if broken:
        msg = f"⚠️ wiki4: 깨진 인용 {len(broken)}건 — " + ", ".join(f"[[{b}]]" for b in broken[:5])
        if len(broken) > 5:
            msg += f" (+{len(broken)-5}건)"
        print(msg, file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    try: main()
    except: sys.exit(0)
