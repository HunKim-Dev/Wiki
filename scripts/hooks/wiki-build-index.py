#!/usr/bin/env python3
"""
wiki-agent Inverted Index Builder

입력: wiki 루트 경로 ($WIKI_PATH/<project>/wiki)
출력: <wiki_root>/.wiki-index.json (token → pages 역인덱스)

모드:
  --full <wiki_root>                — 전체 재빌드
  --incremental <wiki_root> <p1> <p2> ...  — 특정 페이지만 재인덱싱
  --check <wiki_root>               — stale 여부만 반환 (exit 0/1)

스키마:
{
  "version": 1,
  "built_at": "ISO-8601",
  "project": "...",
  "pages_count": N,
  "tokens": {
    "<keyword>": [
      {"path": "concepts/auth/foo.md", "count": 3},
      ...
    ]
  },
  "pages": {
    "concepts/auth/foo.md": {
      "mtime": "ISO-8601",
      "title": "...",
      "kind": "concept",
      "domain": "auth",
      "tokens_count": N,
      "outgoing_links": ["entities/auth/bar", ...]
    }
  }
}

Fallback 안전: 빌드 실패 시 기존 파일 보존 (atomic write via .new → rename).
"""

import os
import sys
import re
import json
import glob
import argparse
from collections import defaultdict, Counter
from datetime import datetime

INDEX_FILENAME = ".wiki-index.json"
INDEX_VERSION = 1

STOPWORDS = {
    "어떻게","뭐야","이거","저거","그거","하기","하면","되는","있나","해야","안되",
    "구현","수정","문제","해결","알려","알려줘","알고","싶어","있는","없는","있어",
    "없어","것","수","때","곳","적","일","중","후","전","을","를","이","가","은","는",
    "의","에","와","과","로","으로","도","만","까지","부터","에서","에게","한테","뿐",
    "how","what","when","where","why","this","that","these","those","the","and","for",
    "with","have","does","would","should","could","will","can","may","might","must",
    "not","but","or","if","then","else","is","are","was","were","be","been","being",
    "to","of","in","on","at","by","from","as","so","too","very","just",
}

EXCLUDE_SUBDIRS = ("lint-reports/", "clarifications/", "actions/")
EXCLUDE_FILES = ("log.md", "index.md")


def iso_now():
    return datetime.now().isoformat(timespec="seconds")


def parse_frontmatter(content):
    """YAML frontmatter 파싱 (표준 고정 필드만). 없으면 빈 dict."""
    if not content.startswith("---"):
        return {}, content
    end = content.find("\n---", 4)
    if end == -1:
        return {}, content
    raw = content[4:end]
    body = content[end + 4:].lstrip("\n")
    meta = {}
    for line in raw.split("\n"):
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if m:
            k, v = m.group(1), m.group(2).strip()
            # strip quotes
            v = v.strip('"').strip("'")
            meta[k] = v
    return meta, body


def extract_tokens(text):
    """한/영 2자+ 토큰. 소문자 정규화. stopwords 제거."""
    tokens = re.findall(r"[가-힣a-zA-Z0-9]{2,}", text.lower())
    return [t for t in tokens if t not in STOPWORDS]


def extract_wiki_links(text):
    """[[wiki-link]] 추출. slug만 반환 (.md 제외)."""
    return [m.group(1) for m in re.finditer(r"\[\[([^\]]+)\]\]", text)]


def extract_domain(rel_path):
    """concepts/auth/foo.md → 'auth'. decisions/xxx.md → None."""
    parts = rel_path.split("/")
    if len(parts) >= 3 and parts[0] in ("concepts", "entities"):
        return parts[1]
    return None


def is_indexable(rel_path):
    """인덱싱 대상인지 판정."""
    if not rel_path.endswith(".md"):
        return False
    if rel_path in EXCLUDE_FILES:
        return False
    for prefix in EXCLUDE_SUBDIRS:
        if rel_path.startswith(prefix):
            return False
    return True


def index_page(wiki_root, rel_path):
    """단일 페이지 인덱싱. (tokens_counter, meta) 반환. 실패 시 (None, None)."""
    abs_path = os.path.join(wiki_root, rel_path)
    try:
        stat = os.stat(abs_path)
        content = open(abs_path, encoding="utf-8").read()
    except Exception:
        return None, None

    meta_raw, body = parse_frontmatter(content)
    tokens = extract_tokens(body)
    tokens_counter = Counter(tokens)

    meta = {
        "mtime": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "title": meta_raw.get("title", ""),
        "kind": meta_raw.get("kind", ""),
        "domain": extract_domain(rel_path),
        "tokens_count": len(tokens),
        "outgoing_links": extract_wiki_links(content),
    }
    return tokens_counter, meta


def collect_pages(wiki_root):
    """wiki_root 하위 인덱싱 대상 페이지 상대경로 목록."""
    pattern = os.path.join(wiki_root, "**", "*.md")
    result = []
    for abs_path in glob.glob(pattern, recursive=True):
        rel = os.path.relpath(abs_path, wiki_root)
        if is_indexable(rel):
            result.append(rel)
    return sorted(result)


def build_full(wiki_root, project_name=None):
    """전체 재빌드."""
    pages = collect_pages(wiki_root)
    tokens_map = defaultdict(list)  # token → [{path, count}]
    pages_meta = {}

    for rel in pages:
        counter, meta = index_page(wiki_root, rel)
        if counter is None:
            continue
        pages_meta[rel] = meta
        for token, count in counter.items():
            tokens_map[token].append({"path": rel, "count": count})

    # Sort each token's page list by count desc (helps hook top-N queries)
    for token in tokens_map:
        tokens_map[token].sort(key=lambda x: -x["count"])

    if project_name is None:
        project_name = os.path.basename(os.path.dirname(wiki_root)) or "unknown"

    return {
        "version": INDEX_VERSION,
        "built_at": iso_now(),
        "project": project_name,
        "pages_count": len(pages_meta),
        "tokens": dict(tokens_map),
        "pages": pages_meta,
    }


def load_index(wiki_root):
    """기존 인덱스 로드. 없으면 None."""
    path = os.path.join(wiki_root, INDEX_FILENAME)
    if not os.path.exists(path):
        return None
    try:
        data = json.load(open(path, encoding="utf-8"))
        if data.get("version") != INDEX_VERSION:
            return None
        return data
    except Exception:
        return None


def update_incremental(wiki_root, index, changed_rel_paths):
    """특정 페이지만 재인덱싱. 기존 tokens·pages 맵에서 삭제→추가."""
    tokens_map = defaultdict(list, {k: list(v) for k, v in index.get("tokens", {}).items()})
    pages_meta = dict(index.get("pages", {}))

    for rel in changed_rel_paths:
        # 기존 tokens 엔트리에서 해당 path 제거
        for token in list(tokens_map.keys()):
            tokens_map[token] = [e for e in tokens_map[token] if e["path"] != rel]
            if not tokens_map[token]:
                del tokens_map[token]
        # 기존 pages 메타 제거
        if rel in pages_meta:
            del pages_meta[rel]

        # 새로 인덱싱 (파일이 삭제됐으면 skip)
        abs_path = os.path.join(wiki_root, rel)
        if not os.path.exists(abs_path):
            continue
        if not is_indexable(rel):
            continue
        counter, meta = index_page(wiki_root, rel)
        if counter is None:
            continue
        pages_meta[rel] = meta
        for token, count in counter.items():
            tokens_map[token].append({"path": rel, "count": count})

    # Re-sort each token's list
    for token in tokens_map:
        tokens_map[token].sort(key=lambda x: -x["count"])

    index["built_at"] = iso_now()
    index["pages_count"] = len(pages_meta)
    index["tokens"] = dict(tokens_map)
    index["pages"] = pages_meta
    return index


def write_index_atomic(wiki_root, index):
    """Atomic write: .new → rename."""
    path = os.path.join(wiki_root, INDEX_FILENAME)
    tmp = path + ".new"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return path


def is_stale(wiki_root, index):
    """페이지 mtime 중 하나라도 index.built_at보다 최신이면 stale."""
    if not index:
        return True
    try:
        built = datetime.fromisoformat(index["built_at"])
    except Exception:
        return True
    pages = collect_pages(wiki_root)
    for rel in pages:
        abs_path = os.path.join(wiki_root, rel)
        try:
            mtime = datetime.fromtimestamp(os.stat(abs_path).st_mtime)
            if mtime > built:
                return True
        except Exception:
            continue
    # 또한 인덱스에 있는 페이지가 삭제됐는지도 체크
    current = set(pages)
    indexed = set(index.get("pages", {}).keys())
    if indexed - current:  # 인덱스에 있는데 현재 없는 파일 = stale
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)

    p_full = sub.add_parser("--full", help="전체 재빌드")
    p_full.add_argument("wiki_root")
    p_full.add_argument("--project")

    p_inc = sub.add_parser("--incremental", help="특정 페이지만 재인덱싱")
    p_inc.add_argument("wiki_root")
    p_inc.add_argument("paths", nargs="+", help="wiki_root 기준 상대경로")

    p_check = sub.add_parser("--check", help="stale 여부만 반환")
    p_check.add_argument("wiki_root")

    # argparse는 `--full` prefix 있는 subcommand를 못 받으므로 직접 파싱
    args = sys.argv[1:]
    if not args:
        print("usage: wiki-build-index.py --full|--incremental|--check <wiki_root> [...]", file=sys.stderr)
        sys.exit(1)

    mode = args[0]
    rest = args[1:]

    if mode == "--full":
        if not rest:
            print("usage: --full <wiki_root> [--project NAME]", file=sys.stderr); sys.exit(1)
        wiki_root = rest[0]
        project = None
        if "--project" in rest:
            idx = rest.index("--project")
            project = rest[idx + 1]
        if not os.path.isdir(wiki_root):
            print(f"wiki_root not dir: {wiki_root}", file=sys.stderr); sys.exit(1)
        index = build_full(wiki_root, project)
        path = write_index_atomic(wiki_root, index)
        print(f"built: {path} ({index['pages_count']} pages, {len(index['tokens'])} tokens)")

    elif mode == "--incremental":
        if len(rest) < 2:
            print("usage: --incremental <wiki_root> <path1> [path2 ...]", file=sys.stderr); sys.exit(1)
        wiki_root, paths = rest[0], rest[1:]
        if not os.path.isdir(wiki_root):
            print(f"wiki_root not dir: {wiki_root}", file=sys.stderr); sys.exit(1)
        existing = load_index(wiki_root)
        if existing is None:
            # 기존 인덱스 없으면 full 빌드로 전환
            index = build_full(wiki_root)
        else:
            index = update_incremental(wiki_root, existing, paths)
        path = write_index_atomic(wiki_root, index)
        print(f"updated: {path} ({index['pages_count']} pages, {len(paths)} paths reindexed)")

    elif mode == "--check":
        if not rest:
            print("usage: --check <wiki_root>", file=sys.stderr); sys.exit(1)
        wiki_root = rest[0]
        index = load_index(wiki_root)
        if is_stale(wiki_root, index):
            print("stale")
            sys.exit(1)
        else:
            print("fresh")
            sys.exit(0)

    else:
        print(f"unknown mode: {mode}", file=sys.stderr); sys.exit(1)


if __name__ == "__main__":
    main()
