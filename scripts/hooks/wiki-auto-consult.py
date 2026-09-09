#!/usr/bin/env python3
"""
wiki4-agent UserPromptSubmit hook — Hybrid mode (v3.0).

철학: v1.3의 결정론적 baseline + v2.0의 LLM 의미 매칭 보강 + cross-project 결정론적 가시화.

v1.3 대비 변경:
  - **같은 그룹 모든 프로젝트의 index.md도 미리 주입** (각 1.5KB) — cross-project 결정론
  - 키워드 매칭 결과를 "후보"로 표현 (LLM이 의미 매칭으로 보강 가능)
  - "후보 부정확하면 의미 매칭으로 추가 Read" 명시 안내

흐름:
  1. activation 체크
  2. 프롬프트에서 키워드 추출 + 의도 감지
  3. 같은 그룹 모든 프로젝트 wiki 페이지 랭킹 (현재 프로젝트 ×1.5 boost)
  4. additionalContext 주입:
     - 의무 규칙 + 의미 매칭 보강 안내
     - 현재 프로젝트 index (3KB)
     - **같은 그룹 다른 프로젝트 index 요약 (각 1.5KB)** ← v3.0 신규
     - top N 페이지 본문 excerpt (각 2.5KB)
     - Signals (precedent-likely / cross-top / work-intent / unmapped-project)
  5. Main Claude가 컨텍스트 + 의미 매칭으로 답변

실패 시 항상 exit 0 (UserPromptSubmit hook은 비-0 종료 시 프롬프트 차단).
로그: ~/.claude/hooks/wiki-auto-consult.log
"""

import os
import sys
import json
import re
import glob
import subprocess
from datetime import datetime

HOME = os.path.expanduser("~")
LOG_PATH = os.path.join(HOME, ".claude", "hooks", "wiki-auto-consult.log")
TSV_PATH = os.path.join(HOME, ".claude", "hooks", "wiki-auto-consult.tsv")

STOPWORDS = {
    # Korean particles·common words
    "어떻게","뭐야","이거","저거","그거","하기","하면","되는","있나","해야","안되",
    "구현","수정","문제","해결","알려","알려줘","알고","싶어","있는","없는","있어",
    "없어","것","수","때","곳","적","일","중","후","전","을","를","이","가","은","는",
    "의","에","와","과","로","으로","도","만","까지","부터","에서","에게","한테","뿐",
    # English common
    "how","what","when","where","why","this","that","these","those","the","and","for",
    "with","have","does","would","should","could","will","can","may","might","must",
    "not","but","or","if","then","else","is","are","was","were","be","been","being",
    "to","of","in","on","at","by","from","as","so","too","very","just",
}


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        ts = datetime.now().isoformat(timespec="seconds")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def tsv_log(event, project="-", org="-", org_method="-", prompt_len=0,
            top_score=0, top_match="-", matched_count=0, keywords_top5=None):
    try:
        os.makedirs(os.path.dirname(TSV_PATH), exist_ok=True)
        ts = datetime.now().isoformat(timespec="seconds")
        kws = ",".join(keywords_top5 or []) or "-"
        safe = lambda s: str(s).replace("\t", " ").replace("\n", " ")
        row = "\t".join(safe(x) for x in [
            ts, event, project, org, org_method, prompt_len,
            top_score, top_match, matched_count, kws,
        ])
        if not os.path.exists(TSV_PATH) or os.path.getsize(TSV_PATH) == 0:
            with open(TSV_PATH, "w", encoding="utf-8") as f:
                f.write("timestamp\tevent\tproject\torg\torg_method\tprompt_len"
                        "\ttop_score\ttop_match\tmatched_count\tkeywords_top5\n")
        with open(TSV_PATH, "a", encoding="utf-8") as f:
            f.write(row + "\n")
    except Exception:
        pass


def emit_output(additional_context):
    out = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": additional_context,
        }
    }
    print(json.dumps(out, ensure_ascii=False))


# ───── settings.json 직접 읽기 (즉시 반영 보장) ─────
# /wiki-config로 변경한 settings.json을 매 hook 호출마다 fresh하게 읽어와
# os.environ의 stale 문제를 우회. 측정 비용 ~0.025ms/호출 (무시 가능).

SETTINGS_PATH = os.path.join(HOME, ".claude", "settings.json")


def load_settings_env():
    """~/.claude/settings.json에서 env 객체 직접 읽기. 실패 시 빈 dict."""
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("env", {}) or {}
    except Exception:
        return {}


def build_runtime_env():
    """settings.json env + os.environ 병합. settings.json 값이 우선 (즉시 반영용).
    WIKI_IN_SKILL 같은 runtime-only 변수는 os.environ에만 존재하므로 그대로 유지."""
    merged = dict(os.environ)
    fresh = load_settings_env()
    for k, v in fresh.items():
        if v:  # 빈 문자열은 무시 (os.environ 값 보존)
            merged[k] = v
    return merged


# ───── Path/org resolution ─────

def detect_project(cwd):
    try:
        src = subprocess.check_output(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL, timeout=2,
        ).decode().strip()
    except Exception:
        src = cwd
    return src, os.path.basename(src)


def get_git_remote(cwd):
    try:
        return subprocess.check_output(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            stderr=subprocess.DEVNULL, timeout=2,
        ).decode().strip()
    except Exception:
        return ""


def parse_csv_mapping(s):
    result = {}
    if not s:
        return result
    for pair in s.split(","):
        pair = pair.strip()
        if "=" in pair:
            k, v = pair.split("=", 1)
            result[k.strip()] = v.strip()
    return result


def resolve_org(project, cwd, env):
    project_orgs = parse_csv_mapping(env.get("WIKI_PROJECT_ORGS", ""))
    if project in project_orgs:
        return project_orgs[project], "explicit"
    remote_patterns = parse_csv_mapping(env.get("WIKI_ORG_REMOTE_PATTERNS", ""))
    if remote_patterns:
        remote = get_git_remote(cwd)
        if remote:
            for pattern, org in remote_patterns.items():
                if pattern in remote:
                    return org, "remote-pattern"
    default_org = env.get("WIKI_DEFAULT_ORG", "")
    if default_org:
        return default_org, "default"
    return "", "none"


# ───── Keyword extraction ─────

def extract_keywords(prompt):
    tokens = re.findall(r"[가-힣a-zA-Z0-9]{2,}", prompt.lower())
    seen = set()
    out = []
    for t in tokens:
        if t in STOPWORDS or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out[:30]


# ───── Work intent vs question intent detection ─────
# 사용자 메시지가 "질문"인지 "작업 요청"인지 분기.
# 작업 요청 + wiki 매칭 → 코드 작성 **전** 4지선다로 사용자 의도 재확인 (CLAUDE.md 정책).
#
# 카테고리별로 패턴을 분리해 엣지 케이스 처리. 더 추가하기 쉬움.

# === 작업 단서 (한국어) ===
# 동작 동사
KO_WORK_VERBS = (
    r"(만들|생성|작성|짜|구현|개발|설계|적용|배치|설치|"
    r"추가|넣|포함|add|append|extend|확장|"
    r"수정|변경|고치|바꾸|교체|교환|업데이트|개정|"
    r"삭제|제거|빼|지우|날리|치우|"
    r"리팩토링|리팩터|리팩|개선|향상|최적화|튜닝|정리|클린업|클린|"
    r"마이그레이션|이전|이동|옮기|포팅|이식|"
    r"통합|병합|합치|merge|"
    r"분리|나누|쪼개|split|"
    r"이름변경|rename|"
    r"새로\s*짜|처음부터|scratch|"
    r"빼내|추출|extract|"
    r"래핑|감싸|wrap|"
    r"래핑풀|언래핑|unwrap|"
    r"훅|연결|hook\s*up|wire\s*up|"
    r"세팅|setup|set\s*up|"
    r"디버깅|debug|"
    r"패치|patch|"
    r"포팅|port"
    r")"
)
# 어미 (요청·의지·청유)
KO_WORK_ENDINGS = (
    r"("
    r"줘|주세요|주실래|줄래|줍시|"
    r"하자|할까|할께|할게|할테|하면|할\s*수\s*있|"
    r"자\b|지\b|"  # "짜자", "만들자", "구현하지" 등 청유형
    r"하고\s*싶|싶어|싶다|싶고|싶은데|"
    r"부탁|부탁해|부탁드려|"
    r"가능해|가능할|가능한가|가능합|"
    r"보자|볼까|봐|봐줘|"
    r"필요해|필요한|필요할|"
    r"해야|해야지|해야할|해야겠|해야함"
    r")"
)
# 합성 패턴
KO_WORK_PATTERNS = [
    # 동사 + 어미
    rf"{KO_WORK_VERBS}\w*\s*\w*\s*{KO_WORK_ENDINGS}",
    # 명사 + 작성·생성·만들
    r"(코드|컴포넌트|함수|메서드|모듈|페이지|뷰|훅|composable|api|엔드포인트|폼|버튼|스크롤|스토어|state|hook|util|테스트|test)\s*\w*\s*(작성|짜|만들|생성|추가|개발|구축)",
    # 짧은 imperative (어미 없이 단독 명령)
    r"(짜줘|만들어|구현해|넣어|추가해|수정해|고쳐|바꿔|작성해|삭제해|제거해|지워|개선해|정리해|이전해|옮겨)",
    # 청유형 단독 ("짜자", "만들자", "고치자", "바꾸자", "추가하자" 등)
    r"\b(짜자|만들자|구현하자|넣자|추가하자|수정하자|고치자|바꾸자|작성하자|삭제하자|지우자|개선하자|정리하자|이전하자|옮기자|리팩토링하자|마이그레이션하자|새로\s*짜자|새로\s*만들자|다시\s*짜자|다시\s*만들자)",
    # 분석·도움 요청 (작업으로 분류)
    r"(도와줘|도와주세요|도와줄래|help\s*me)",
    # 마이그레이션·교체 명사형 + 의지
    r"(마이그레이션|리팩토링|이전|교체)\s*(하자|할까|해야|해줘|좀|진행)",
    # "X로 바꾸자/하자" 등 청유형
    r"\w+\s*(으로|로|에)\s*(바꾸|변경|이동|옮기|적용)",
    # "X 좀 V" 형태 (좀이 들어가면 거의 작업)
    r"\w+\s*좀\s*(만들|짜|넣|추가|수정|고치|바꾸|삭제|지우|작성|개선|정리)",
]

# === 작업 단서 (영어) ===
EN_WORK_VERBS = (
    r"(build|create|make|write|draft|scaffold|"
    r"add|append|extend|include|"
    r"implement|develop|design|"
    r"refactor|rework|restructure|cleanup|clean\s*up|"
    r"fix|patch|tweak|update|modify|change|edit|adjust|"
    r"remove|delete|strip|drop|"
    r"migrate|port|move|"
    r"merge|combine|integrate|consolidate|"
    r"split|separate|extract|"
    r"rename|"
    r"replace|swap|substitute|"
    r"improve|enhance|optimize|tune|"
    r"introduce|"
    r"rebuild|rewrite|redo|"
    r"setup|set\s*up|configure|"
    r"wire\s*up|hook\s*up|"
    r"wrap|unwrap|"
    r"debug)"
)
EN_WORK_PATTERNS = [
    # bare imperative — 문장 시작 또는 명령
    rf"(?:^|[.!?]\s+){EN_WORK_VERBS}\b",
    # 청유·요청 표현
    rf"(?:let'?s?|let\s+us|we\s+(?:should|could|need\s+to|gotta|have\s+to)|"
    rf"i\s+(?:want\s+to|need\s+to|would\s+like\s+to|gotta|have\s+to|should)|"
    rf"need\s+to|going\s+to|gonna|"
    rf"please|could\s+you|can\s+you|would\s+you)\s+\w*\s*{EN_WORK_VERBS}",
    # "would you mind ~ing" / "do you mind ~ing" → 정중 요청
    rf"(?:would|do|could)\s+you\s+mind\s+\w*\s*{EN_WORK_VERBS}\w*",
    # V-ing form 정중 요청 (mind cleaning up, mind adding 등)
    r"\b(mind|consider|try)\s+(building|creating|making|writing|drafting|adding|appending|extending|implementing|developing|refactoring|reworking|cleaning|fixing|patching|tweaking|updating|modifying|changing|editing|removing|deleting|migrating|moving|merging|splitting|extracting|renaming|replacing|swapping|improving|enhancing|optimizing|introducing|rebuilding|rewriting|setting|wiring|hooking|wrapping|debugging)",
    # "help me X"
    rf"help\s+(?:me\s+)?(?:to\s+)?{EN_WORK_VERBS}",
    # "make/build/etc + a/the/some" (object after work verb)
    rf"\b{EN_WORK_VERBS}\s+(?:a|the|an|some|new|this|that)?\s*\w+",
]

WORK_INTENT_PATTERNS = KO_WORK_PATTERNS + EN_WORK_PATTERNS

# === 질문 단서 (한국어) ===
KO_QUESTION_PATTERNS = [
    # 의문문 종결어미
    r"\?(\s|$)",
    r"(어떻게|어떤|어떤지|어디|언제|누가|왜|무엇|뭐|뭔|뭘|뭐가|얼마|어느|몇)",
    # "~인가/~일까/~지/~ㄴ가" 등 의문 종결
    r"(인가|일까|일까요|지\?|는가|을까|는지|는가요|나요|아요\?|어요\?|니\?|냐\?)",
    # 정보 요청 동사 (정보 답변 요청 = 질문) — "정리"는 작업과 충돌 우려로 제외
    r"(알려|설명|소개|요약|보여|찾아|기억|이해|확인|진단|점검|검토|review|리뷰)\s*(줘|주세요|해|해줘|하자|할께|할까)",
    # 분석은 검토에 가까움 (정보 요청)
    r"(분석)\s*(좀|해|해줘|줘|해주실|좀\s*해)",
    # 존재 확인
    r"(있어|있나|있는|있어요|있습|있을|존재|exist)",
    # 의견·판단 묻기
    r"(어떻게\s*생각|어떨\s*것\s*같|어떤가|괜찮아|괜찮을|맞아|맞나|맞을|적절|적합|좋을\s*까|나을\s*까|recommend|추천)",
    # 비교
    r"(vs|차이|대비|비교|compare|difference|versus)",
    # "X가 뭐야?" / "X란?" 등
    r"(란\s*\?|이란\s*\?|뭐야|뭐냐|무엇이|무엇인지)",
    # "~ 했어?" / "~ 했나?" 과거형 질문
    r"(했어|했나|했지|됐어|됐나|됐지|돼\?|되나|돼요\?)",
]

# === 강한 작업 의지 표현 (가중치 ↑ — 질문 단서가 같이 있어도 작업 우선) ===
# "싶다·싶은데·싶어·싶고·싶은" 등 의지 표현은 작업 의지로 강하게 카운트

# 영어 V-ing form (정중 요청 + V-ing 패턴용)
EN_WORK_VERBS_ING = (
    r"(building|creating|making|writing|drafting|scaffolding|"
    r"adding|appending|extending|"
    r"implementing|developing|designing|"
    r"refactoring|reworking|restructuring|cleaning|"
    r"fixing|patching|tweaking|updating|modifying|changing|editing|adjusting|"
    r"removing|deleting|stripping|dropping|"
    r"migrating|porting|moving|"
    r"merging|combining|integrating|consolidating|"
    r"splitting|separating|extracting|"
    r"renaming|"
    r"replacing|swapping|substituting|"
    r"improving|enhancing|optimizing|tuning|"
    r"introducing|"
    r"rebuilding|rewriting|redoing|"
    r"setting|configuring|"
    r"wiring|hooking|"
    r"wrapping|unwrapping|"
    r"debugging)"
)

STRONG_WORK_INTENT_PATTERNS = [
    # 한국어 의지·필요 표현 + 동사
    r"(만들|추가|구현|짜|작성|개발|생성|적용|넣|수정|변경|고치|바꾸|리팩토|이전|마이그레이션|개선|정리|삭제|제거)\w*\s*\w*\s*(고\s*싶|싶은데|싶어|싶다|싶고|싶은|싶음|해야|해야지|해야겠|해야할|해야겠어)",
    # "X 좀 ~할래?" / "X 좀 ~줄래?" 짧은 정중 요청
    r"(좀\s*\w*\s*(만들|추가|구현|짜|넣|수정|고쳐|바꿔|삭제|지워|정리|개선))",
    # "~줄래/주실래/줄까" + 작업동사 (짧은 prompt 보강)
    r"(만들|추가|구현|짜|넣|수정|고치|고쳐|바꾸|바꿔|삭제|제거|지우|개선|정리|이전|옮기|옮겨|작성|개발|리팩토)\w*\s*\w*\s*(줄래|주실래|줄까|주세요|줘)",
    # 청유형 단독 ("짜자", "만들자" 등)
    r"\b(짜자|만들자|구현하자|넣자|추가하자|수정하자|고치자|바꾸자|작성하자|삭제하자|지우자|개선하자|정리하자|이전하자|옮기자|리팩토링하자|마이그레이션하자|새로\s*짜자|새로\s*만들자|다시\s*짜자|다시\s*만들자)",
    # 영어 의지·필요 표현 + base verb
    r"\b(want\s+to|need\s+to|gotta|have\s+to|going\s+to|gonna|would\s+like\s+to|i'?d\s+like\s+to|wanna)\s+\w*\s*"
    + EN_WORK_VERBS,
    # 영어 정중 요청 + base verb
    r"\b(could\s+you|can\s+you|please|would\s+you)\s+\w*\s*" + EN_WORK_VERBS,
    # 영어 정중 요청 + V-ing (would you mind cleaning, do you mind adding 등)
    r"\b(would|do|could)\s+you\s+(mind|consider|try)\s+\w*\s*" + EN_WORK_VERBS_ING,
    # "let's try V-ing" / "can we try V-ing" / "want to try V-ing"
    r"\b(let'?s|can\s+we|i\s+want\s+to|i'?d\s+like\s+to|gonna)\s+(try|consider|attempt|start)\s+\w*\s*" + EN_WORK_VERBS_ING,
    # "we should/could/might + V" 의무·제안
    r"\b(we|i)\s+(should|could|might|must|need\s+to|have\s+to)\s+\w*\s*" + EN_WORK_VERBS,
]

# === 질문 단서 (영어) ===
EN_QUESTION_PATTERNS = [
    r"\?(\s|$)",
    r"\b(what|how|why|when|where|who|which|whose|whom)\b.*\?",
    r"\b(what'?s|how'?s|why'?s|where'?s)\b",
    r"\b(do|does|did|is|are|was|were|can|could|will|would|should|may|might)\s+\w+\s+\w+\?",
    # 정보 요청
    r"\b(tell\s+me|explain|describe|summarize|show\s+me|outline|walk\s+me\s+through)\b",
    r"\b(any|is\s+there|are\s+there)\b",
    # 의견·비교
    r"\b(thoughts|opinion|recommend|prefer|better|worse|vs\.?|versus|compare|difference)",
]

QUESTION_PATTERNS = KO_QUESTION_PATTERNS + EN_QUESTION_PATTERNS


def _has_any(patterns, text):
    return any(re.search(pat, text) for pat in patterns)


def detect_work_intent(prompt):
    """
    사용자 메시지가 작업 요청인지 판별.

    Rules:
      0. 강한 작업 의지 (싶다·want to·could you ~ + 동사) 매칭 → 무조건 work (질문 단서 무시)
      1. 작업 단서 있음 + 질문 단서 없음 → work
      2. 둘 다 있음 (긴 prompt, ≥30자) → 마지막 30% 기준으로 추정
      3. 둘 다 있음 (짧은 prompt, <30자) → 전체로 판단. 작업 동사 + 정중 요청(줘/줄래/please)이면 work
      4. 작업 단서 없음 → not work
    """
    p = prompt.lower()

    # Rule 0: 강한 작업 의지 — 질문 형태라도 work
    if _has_any(STRONG_WORK_INTENT_PATTERNS, p):
        return True

    has_work = _has_any(WORK_INTENT_PATTERNS, p)
    has_question = _has_any(QUESTION_PATTERNS, p)

    if not has_work:
        return False

    if has_work and not has_question:
        return True

    # 짧은 prompt — 마지막 30% 룰이 의미 없음 (단서가 잘림)
    if len(p) < 30:
        # 짧은 prompt + work 동사 + 정중 요청 어미 → work
        polite_request = re.search(
            r"(줘|주세요|줄래|주실래|줄까|please|could\s+you|can\s+you)",
            p
        )
        info_req = re.search(
            r"(알려|설명|소개|요약|tell\s+me|explain|describe|summarize)",
            p
        )
        if info_req:
            return False
        if polite_request:
            return True
        # work만 있고 정중 요청 없으면 → 질문 단서 우선 (의문문일 가능성)
        return False

    # 긴 prompt — 마지막 30% 기준
    last_third_start = int(len(p) * 0.7)
    tail = p[last_third_start:]

    tail_has_work = _has_any(WORK_INTENT_PATTERNS, tail)
    tail_has_question = _has_any(QUESTION_PATTERNS, tail)

    if tail_has_work and not tail_has_question:
        return True
    if tail_has_question and not tail_has_work:
        return False

    # tail에 둘 다 있거나 둘 다 없음 → 정보 요청이면 질문, 아니면 보수적 작업
    info_req = re.search(
        r"(알려|설명|소개|요약|tell\s+me|explain|describe|summarize)\s*(줘|주세요|me)?",
        tail
    )
    if info_req:
        return False
    return True


# ───── Inverted index (있으면) + grep fallback ─────

INDEX_FILENAME = ".wiki4-index.json"
INDEX_VERSION = 1


def try_load_index(wiki_root):
    path = os.path.join(wiki_root, INDEX_FILENAME)
    if not os.path.exists(path):
        return None
    try:
        data = json.load(open(path, encoding="utf-8"))
    except Exception:
        return None
    if data.get("version") != INDEX_VERSION:
        return None
    try:
        built_epoch = datetime.fromisoformat(data["built_at"]).timestamp()
    except Exception:
        return None

    STALE_TOLERANCE_SEC = 1.0
    try:
        pattern = os.path.join(wiki_root, "**", "*.md")
        for md in glob.glob(pattern, recursive=True):
            rel = os.path.relpath(md, wiki_root)
            if rel in ("log.md", "index.md"):
                continue
            if rel.startswith(("lint-reports/", "clarifications/", "actions/")):
                continue
            try:
                mtime = os.stat(md).st_mtime
            except Exception:
                continue
            if mtime > built_epoch + STALE_TOLERANCE_SEC:
                return None
        indexed_paths = set(data.get("pages", {}).keys())
        current_paths = set()
        for md in glob.glob(pattern, recursive=True):
            rel = os.path.relpath(md, wiki_root)
            if rel in ("log.md", "index.md"):
                continue
            if rel.startswith(("lint-reports/", "clarifications/", "actions/")):
                continue
            current_paths.add(rel)
        if indexed_paths - current_paths:
            return None
    except Exception:
        return None

    return data


def rank_pages_via_index(index, keywords):
    page_scores = {}
    tokens = index.get("tokens", {})
    for kw in keywords:
        entries = tokens.get(kw)
        if not entries:
            continue
        for entry in entries:
            rel = entry["path"]
            count = entry["count"]
            if rel not in page_scores:
                page_scores[rel] = [0, []]
            page_scores[rel][0] += count
            page_scores[rel][1].append(kw)
    results = [(rel, s[0], s[1]) for rel, s in page_scores.items()]
    results.sort(key=lambda x: -x[1])
    return results


def rank_pages_via_grep(wiki_root, keywords):
    results = []
    pattern = os.path.join(wiki_root, "**", "*.md")
    for md in glob.glob(pattern, recursive=True):
        rel = os.path.relpath(md, wiki_root)
        if rel in ("log.md", "index.md"):
            continue
        if rel.startswith(("lint-reports/", "clarifications/", "actions/")):
            continue
        try:
            content = open(md, encoding="utf-8").read()
        except Exception:
            continue
        content_lower = content.lower()
        matched_kws = []
        score = 0
        for kw in keywords:
            count = content_lower.count(kw)
            if count > 0:
                score += count
                matched_kws.append(kw)
        if score > 0:
            results.append((rel, score, matched_kws))
    results.sort(key=lambda x: -x[1])
    return results


def rank_pages(wiki_root, keywords):
    index = try_load_index(wiki_root)
    if index is not None:
        results = rank_pages_via_index(index, keywords)
        log(f"rank: via index ({index.get('pages_count', '?')} pages)")
        return results
    log("rank: via grep (no/stale index)")
    return rank_pages_via_grep(wiki_root, keywords)


# ───── Excerpt 추출 ─────

def excerpt_with_match_context(content, keywords, ctx_lines=5, header_lines=15, max_chars=2500):
    """매칭 라인 앞뒤 ctx_lines + 파일 머리 header_lines 포함 excerpt."""
    lines = content.split("\n")
    n = len(lines)
    if n == 0:
        return ""

    include = set()
    for i in range(min(header_lines, n)):
        include.add(i)

    kws_lower = [k.lower() for k in keywords]
    for i, line in enumerate(lines):
        ll = line.lower()
        if any(kw in ll for kw in kws_lower):
            for j in range(max(0, i - ctx_lines), min(n, i + ctx_lines + 1)):
                include.add(j)

    sorted_nums = sorted(include)
    parts = []
    prev = -2
    for num in sorted_nums:
        if num > prev + 1 and prev != -2:
            parts.append("    ...")
        parts.append(lines[num])
        prev = num

    excerpt = "\n".join(parts)
    if len(excerpt) > max_chars:
        excerpt = excerpt[:max_chars] + "\n    ...(추가 축약)"
    return excerpt


# ───── Main ─────

def main():
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        log(f"stdin parse fail: {e}")
        sys.exit(0)

    prompt = event.get("prompt", "") or event.get("user_prompt", "")
    cwd = event.get("cwd", os.getcwd())

    log(f"invoked; cwd={cwd} prompt_len={len(prompt)}")

    # settings.json 직접 읽기 — /wiki-config 변경이 즉시 반영되도록
    env = build_runtime_env()

    if env.get("WIKI_AUTOCONSULT", "") == "0":
        tsv_log("skip-disabled", prompt_len=len(prompt))
        sys.exit(0)

    if env.get("WIKI_IN_SKILL", "") == "1":
        log("skip: WIKI_IN_SKILL=1 (recursion guard)")
        tsv_log("skip-recursion", prompt_len=len(prompt))
        sys.exit(0)

    wiki_path = env.get("WIKI_PATH", "")
    if not wiki_path or not os.path.isdir(wiki_path):
        tsv_log("skip-no-env", prompt_len=len(prompt))
        sys.exit(0)

    src, project = detect_project(cwd)

    if src.startswith("/Users/grove/WorkSpace/wiki3") or src.startswith("/Users/grove/WorkSpace/wiki4"):
        log(f"skip: engine repo ({src})")
        tsv_log("skip-engine-repo", project=project, prompt_len=len(prompt))
        sys.exit(0)

    org, org_method = resolve_org(project, cwd, env)
    if not org:
        tsv_log("skip-no-org", project=project, prompt_len=len(prompt))
        sys.exit(0)

    log(f"org resolved: {project} → {org} (via {org_method})")

    wiki_root = os.path.join(wiki_path, org, project, "wiki")
    idx_path = os.path.join(wiki_root, "index.md")

    org_root = os.path.join(wiki_path, org)
    has_any_in_org = False
    if os.path.isdir(org_root):
        for proj_dir in os.listdir(org_root):
            if os.path.isfile(os.path.join(org_root, proj_dir, "wiki", "index.md")):
                has_any_in_org = True
                break
    if not has_any_in_org:
        tsv_log("skip-empty-org", project=project, org=org, prompt_len=len(prompt))
        sys.exit(0)

    keywords = extract_keywords(prompt)

    scope_mode = env.get("WIKI_SCOPE", "org").strip().lower()
    current_only = scope_mode == "current"
    CURRENT_PROJECT_BOOST = 1.5

    ranked_uniform = []
    if keywords:
        if current_only:
            log("scope: current-only")
            for rel, score, kws in rank_pages(wiki_root, keywords):
                abs_path = os.path.join(wiki_root, rel)
                ranked_uniform.append((abs_path, rel, score, kws))
        else:
            log(f"scope: org-wide (boost {project} by ×{CURRENT_PROJECT_BOOST})")
            if os.path.isdir(org_root):
                for proj_dir in sorted(os.listdir(org_root)):
                    proj_wiki = os.path.join(org_root, proj_dir, "wiki")
                    if not os.path.isdir(proj_wiki):
                        continue
                    if not os.path.isfile(os.path.join(proj_wiki, "index.md")):
                        continue
                    is_current = (proj_dir == project)
                    boost = CURRENT_PROJECT_BOOST if is_current else 1.0
                    for rel, score, kws in rank_pages(proj_wiki, keywords):
                        abs_path = os.path.join(proj_wiki, rel)
                        boosted = int(score * boost)
                        label = rel if is_current else f"[{proj_dir}] {rel}"
                        ranked_uniform.append((abs_path, label, boosted, kws))
            ranked_uniform.sort(key=lambda x: -x[2])

    top = ranked_uniform[:5]

    explicit_mapping = parse_csv_mapping(env.get("WIKI_PROJECT_ORGS", ""))
    unmapped_project = org_method == "default" and project not in explicit_mapping
    cross_top = bool(top and not current_only and top[0][1].startswith("["))

    signals = [f"scope={'current' if current_only else 'org-wide'}"]
    if cross_top:
        cross_proj = top[0][1].split("]")[0].lstrip("[")
        signals.append(f"cross-top={cross_proj}")
    if unmapped_project:
        signals.append(f"unmapped-project={project}:{org}")

    # 답변에 정밀한 4지선다·코드 스니펫 강제하기 위해 매칭 페이지에 **결정·구현 패턴 페이지가 있는지** 미리 표시
    has_decision = any("decisions/" in label for _, label, _, _ in top)
    has_concept_or_entity = any(
        ("concepts/" in label or "entities/" in label)
        for _, label, _, _ in top
    )
    precedent_likely = has_decision or has_concept_or_entity
    if precedent_likely:
        signals.append("precedent-likely=true")

    # 작업 모드 vs 질문 모드 분기 — 작업 모드면 4지선다를 답변 시작 부분에 띄워야 함
    work_intent = detect_work_intent(prompt)
    if work_intent:
        signals.append("work-intent=true")

    header = f"## [wiki-context: {org}/{project} | {' | '.join(signals)}]"
    parts = [header + "\n\n"]
    parts.append(
        "아래는 wiki에서 자동 추출된 컨텍스트입니다.\n\n"
        "## ⚠️ 답변 작성 의무 (생략 금지)\n\n"
        "1. **wiki 우선 참조** — 코드 검색·자체 분석보다 wiki 내용 먼저 활용\n"
        "2. **`[[wiki-link]]` 명시 인용 의무** — 답변에 매칭 페이지를 `[[concepts/<domain>/<slug>]]` 또는 `[[decisions/<id>]]` 형식으로 **반드시 1개 이상** 인용. 소스 코드 경로(`apps/...`)만 인용하고 wiki 페이지는 안 적는 것 = 규칙 위반\n"
        "3. **추측 금지** — wiki에 없는 정보는 \"wiki에 해당 정보 없음\" 명시\n"
        "4. **🔴/⚠️ 플래그 보존** — 매칭 페이지에 있으면 답변에 반드시 포함\n"
        "5. **의미 매칭 보강 (v3.0 신규)** — 아래 \"Matched pages\"는 키워드 매칭 결과 **후보**일 뿐. "
        "사용자 질문과 의미적으로 더 가까운 페이지가 wiki에 있을 수 있음:\n"
        "   - 키워드 정확 일치 안 돼도 동의어·다국어·추상화 매칭 적극 시도\n"
        "     (예: \"잠금\" ↔ \"차단·쿨다운·body-scroll-lock\", \"newsletter\" ↔ \"뉴스레터\", \"팝업\" ↔ \"modal\")\n"
        "   - 후보 페이지가 부정확하다 판단되면 아래 같은 그룹 다른 프로젝트의 index 보고 "
        "더 나은 페이지를 직접 `Read tool`로 확보 가능\n"
        "   - 답변에는 **키워드 매칭이 아닌 의미적으로 가장 정확한 페이지** 인용\n\n"
        "**올바른 인용 예시**:\n"
        "> 핵심은 [[concepts/scroll/full-page-scroll-engine]]에 정리된 5-layer guard 패턴입니다. "
        "구체 구현은 `apps/main-app/app/composables/use-full-page-scroll.ts`에 있고...\n\n"
        "**잘못된 예시 (wiki 인용 누락)**:\n"
        "> 핵심은 `apps/main-app/app/composables/use-full-page-scroll.ts`에 5-layer guard로 구현돼있어요...\n\n"
    )

    if cross_top:
        cross_proj = top[0][1].split("]")[0].lstrip("[")
        parts.append(f"⚠️ 현재 프로젝트엔 직접 매칭 없음 → 같은 org `{cross_proj}` 페이지 상위. "
                     f"답변 서두에 \"현재 프로젝트 wiki에는 없어 `{cross_proj}`에서 참조합니다\" 명시.\n\n")

    if unmapped_project:
        parts.append(f"ℹ️ 프로젝트 `{project}`가 기본 org `{org}`로 폴백 해석됨. "
                     f"답변 말미에 settings.json `WIKI_PROJECT_ORGS` 추가 안내.\n\n")

    if precedent_likely and work_intent:
        # 작업 모드 — 코드 작성 시작 **전** 4지선다
        parts.append(
            "🛑 **작업 모드 + 판례 감지** — 사용자가 구현/추가/수정을 요청했고 wiki에 "
            "비슷한 패턴이 이미 있습니다. **코드 작성·Edit·Write 시작하지 말고**, 답변 "
            "**시작 부분**에 다음 4지선다를 먼저 출력 후 사용자 응답을 기다리세요:\n\n"
            "```\n"
            "⏸️ 잠깐 — wiki에 비슷한 게 있어요\n\n"
            "[[<wiki page>]]에 <패턴 한 줄 설명>이 정리돼있습니다.\n\n"
            "📌 과거 구현 (요약):\n"
            "```<lang>\n"
            "// from: <ref>\n"
            "<핵심 코드>\n"
            "```\n\n"
            "이대로 반영하시겠어요?\n"
            "(A) 똑같이 반영 — 위 패턴 그대로 적용\n"
            "(B) 부분 반영 — 다음 중 선택: [scope items]\n"
            "(C) 새로 판단 — 이번 케이스는 다른 방식 (이유 명시)\n"
            "(D) 참고만 — wiki는 참고하되 사용자 원래 요청대로 진행\n"
            "```\n\n"
            "사용자가 (A)/(B)/(C)/(D) 응답할 때까지 코드 작성 보류. 응답 후 그에 맞춰 진행.\n\n"
            "**상세 정책은 `~/.claude/CLAUDE.md`의 LLM Wiki Auto-Consult — 작업 모드 섹션 참조.**\n\n"
        )
    elif precedent_likely:
        # 질문 모드 — 답변 끝에 4지선다 (기존 동작)
        parts.append(
            "⚠️ **판례·재사용 후보 감지 (질문 모드)** — 매칭 페이지에 결정(`decisions/`) 또는 "
            "구현 패턴(`concepts/`·`entities/`)이 포함됨. 답변 **끝**에 다음을 **반드시** 출력:\n\n"
            "1. `📌 과거 구현 (요약):` + 매칭 페이지의 코드 블록 핵심 15-30줄 (있으면)\n"
            "2. 4지선다 (A 똑같이 반영 / B 부분 반영 [scope items 3개] / C 새로 판단 / D 참고만)\n\n"
            "**상세 포맷·트리거 조건은 `~/.claude/CLAUDE.md`의 LLM Wiki Auto-Consult 섹션 참조.**\n\n"
        )

    try:
        idx = open(idx_path, encoding="utf-8").read() if os.path.isfile(idx_path) else ""
    except Exception:
        idx = ""
    if idx:
        parts.append(f"### Index — 현재 프로젝트 ({project})\n\n")
        parts.append(idx[:3000])
        if len(idx) > 3000:
            parts.append(f"\n\n...(index 축약: 전체 {len(idx)}자)")
        parts.append("\n\n")

    # ───── v3.0 신규: 같은 그룹 다른 프로젝트 index 주입 ─────
    # cross-project 결정론적 가시화. LLM이 의미 매칭으로 다른 프로젝트 페이지 활용 가능.
    if not current_only:
        sister_indexes = []
        if os.path.isdir(org_root):
            for proj_dir in sorted(os.listdir(org_root)):
                if proj_dir == project:
                    continue  # 현재 프로젝트 제외
                sister_idx_path = os.path.join(org_root, proj_dir, "wiki", "index.md")
                if os.path.isfile(sister_idx_path):
                    try:
                        with open(sister_idx_path, encoding="utf-8") as f:
                            sister_content = f.read()
                        sister_indexes.append((proj_dir, sister_content))
                    except Exception:
                        continue

        if sister_indexes:
            parts.append(f"### 같은 그룹 다른 프로젝트 Index — cross-project 가시화 (그룹: {org})\n\n")
            parts.append(
                "현재 프로젝트에 매칭이 약하면 아래 다른 프로젝트의 페이지를 "
                "**의미 매칭으로 식별 후 `Read tool`로 직접 확보**해 답변에 활용하세요. "
                "인용 시 `[[<project>:concepts/<domain>/<slug>]]` 형식 또는 그냥 `[[concepts/...]]` 사용.\n\n"
            )
            for proj_dir, content in sister_indexes:
                parts.append(f"#### [{proj_dir}] index\n\n")
                # 각 sister index를 1500자로 축약
                parts.append(content[:1500])
                if len(content) > 1500:
                    parts.append(f"\n\n...(축약: 전체 {len(content)}자, 필요하면 직접 Read)")
                parts.append("\n\n")

    if top:
        parts.append(f"### Matched pages — 키워드 매칭 후보 (keywords={keywords[:10]})\n\n")
        for abs_path, label, score, kws in top:
            try:
                body = open(abs_path, encoding="utf-8").read()
            except Exception:
                continue
            excerpt = excerpt_with_match_context(body, kws, ctx_lines=5, header_lines=15, max_chars=2500)
            parts.append(
                f"#### `{label}` — score={score}, matched={kws}\n\n"
                f"```markdown\n{excerpt}\n```\n\n"
            )
    else:
        parts.append("### Matched pages\n\n(none — index만 참조)\n\n")

    parts.append(f"(hook: wiki4-agent v3.0 hybrid — matched={len(top)}/{len(ranked_uniform)})\n")

    additional = "".join(parts)
    emit_output(additional)
    log(f"injected: {len(additional)} bytes, {len(top)} matched pages, precedent_likely={precedent_likely}")

    if top:
        _abs, top_match_rel, top_score, _top_kws = top[0]
    else:
        top_match_rel, top_score = "-", 0
    tsv_log(
        "injected",
        project=project, org=org, org_method=org_method,
        prompt_len=len(prompt),
        top_score=top_score, top_match=top_match_rel,
        matched_count=len(top),
        keywords_top5=keywords[:5],
    )
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"fatal: {type(e).__name__}: {e}")
        sys.exit(0)
