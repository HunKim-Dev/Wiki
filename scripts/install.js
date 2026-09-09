#!/usr/bin/env node
// wiki4-agent postinstall:
//   1) WIKI_PATH 자동 감지 → ~/.claude/settings.json env.WIKI_PATH 주입
//   2) WIKI_ORGS 인터랙티브 선택 → settings.json env.WIKI_ORGS / WIKI_DEFAULT_ORG
//   3) skills/*/ → ~/.claude/skills/*/ 심볼릭 링크
//   4) UserPromptSubmit hook 등록
//   5) ~/.claude/CLAUDE.md에 auto-consult 블록 주입
//
// 사용자는 매 세션 export 할 필요 없음 — settings.json의 env가 Claude Code 시작 시 자동 적용.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HOME = os.homedir();
const PKG_ROOT = path.resolve(__dirname, '..');
const SRC_SKILLS = path.join(PKG_ROOT, 'skills');
const DEST_SKILLS = path.join(HOME, '.claude', 'skills');
const CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const AUTO_CONSULT_TEMPLATE = path.join(PKG_ROOT, 'scripts', 'auto-consult-template.md');
const HOOK_SRC = path.join(PKG_ROOT, 'scripts', 'hooks', 'wiki-auto-consult.py');
const HOOK_DEST_DIR = path.join(HOME, '.claude', 'hooks');
const HOOK_DEST = path.join(HOOK_DEST_DIR, 'wiki4-auto-consult.py');
// Stop hook (인용 검증, 2026-04-29 신규)
const CITE_HOOK_SRC = path.join(PKG_ROOT, 'scripts', 'hooks', 'wiki-cite-verify.py');
const CITE_HOOK_DEST = path.join(HOOK_DEST_DIR, 'wiki4-cite-verify.py');
// 구·신 버전 마커 모두 매칭 (regex)
const MARKER_RE_BEGIN = /<!--\s*wiki4-agent auto-consult v\d+\.\d+ begin\s*-->/;
const MARKER_RE_END = /<!--\s*wiki4-agent auto-consult v\d+\.\d+ end\s*-->/;

const WIKI_PATH_CANDIDATES = [
  path.join(HOME, 'wiki4docs'),
  path.join(HOME, 'WorkSpace', 'wiki4docs'),
  path.join(HOME, 'workspace', 'wiki4docs'),
  path.join(HOME, 'Documents', 'wiki4docs'),
  path.join(HOME, 'Projects', 'wiki4docs'),
  path.join(HOME, 'projects', 'wiki4docs'),
  path.join(HOME, 'Code', 'wiki4docs'),
  path.join(HOME, 'code', 'wiki4docs'),
  path.join(HOME, 'Dev', 'wiki4docs'),
  path.join(HOME, 'dev', 'wiki4docs'),
  path.join(HOME, 'src', 'wiki4docs'),
  path.join(HOME, 'wiki-data'),
];
const DEFAULT_WIKI_PATH = path.join(HOME, 'WorkSpace', 'wiki4docs');

// ax_wiki_agent와 동일 초기 목록. 사용자는 여기서 1개+ 선택.
// 신규 org 추가는 사용자가 settings.json의 WIKI_ORGS CSV 직접 편집 OR 소스 수정 후 재설치.
const DEFAULT_ORGS = ['TT', 'BeautyPoint', 'Krafton', 'Hongkong', 'SI'];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

// ---------- WIKI_PATH 자동 감지 + settings.json 주입 ----------

function discoverWikiPath() {
  for (const c of WIKI_PATH_CANDIDATES) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  return null;
}

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    const backup = `${SETTINGS_FILE}.bak-${Date.now()}`;
    console.error(`[wiki4-agent] ${SETTINGS_FILE} 파싱 실패 (${e.message}) → 백업: ${backup}`);
    fs.copyFileSync(SETTINGS_FILE, backup);
    return {};
  }
}

function writeSettings(data) {
  ensureDir(path.dirname(SETTINGS_FILE));
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function ensureWikiPath() {
  const settings = readSettings();
  const existingPath = settings.env && settings.env.WIKI_PATH;

  if (existingPath && fs.existsSync(existingPath) && fs.statSync(existingPath).isDirectory()) {
    console.log(`[wiki4-agent] WIKI_PATH 유지: ${existingPath}`);
    return existingPath;
  }

  let chosen = discoverWikiPath();
  if (chosen) {
    console.log(`[wiki4-agent] WIKI_PATH 자동 감지: ${chosen}`);
  } else {
    chosen = DEFAULT_WIKI_PATH;
    ensureDir(chosen);
    console.log(`[wiki4-agent] WIKI_PATH 후보 없음 → 기본값 생성: ${chosen}`);
  }

  settings.env = settings.env || {};
  settings.env.WIKI_PATH = chosen;
  writeSettings(settings);
  console.log(`[wiki4-agent] ~/.claude/settings.json env.WIKI_PATH 주입 완료`);
  return chosen;
}

// ---------- WIKI_ORGS 인터랙티브 선택 ----------

async function ensureOrgs() {
  const settings = readSettings();
  const existingOrgs = settings.env && settings.env.WIKI_ORGS;

  if (existingOrgs) {
    const orgList = existingOrgs.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`[wiki4-agent] WIKI_ORGS 유지: ${orgList.join(', ')}`);
    return orgList;
  }

  console.log('');
  console.log('  [WIKI_ORGS] 등록된 조직 목록:');
  DEFAULT_ORGS.forEach((o, i) => console.log(`    ${i + 1}. ${o}`));
  console.log('');

  const sel = (await prompt('  담당 조직 번호 (쉼표 구분, 단일 or 다중, 비우면 전체): ')).trim();
  let selected = [];
  if (!sel) {
    selected = [...DEFAULT_ORGS];
    console.log(`  → 전체 선택`);
  } else {
    const indices = sel.split(',').map(s => s.trim()).filter(Boolean);
    for (const idx of indices) {
      const n = Number(idx);
      if (Number.isInteger(n) && n >= 1 && n <= DEFAULT_ORGS.length) {
        selected.push(DEFAULT_ORGS[n - 1]);
      }
    }
    if (selected.length === 0) {
      selected = [...DEFAULT_ORGS];
      console.log(`  → 유효한 선택 없음 — 전체 사용`);
    } else {
      console.log(`  → 선택: ${selected.join(', ')}`);
    }
  }

  const defaultOrg = selected[0];
  settings.env = settings.env || {};
  settings.env.WIKI_ORGS = selected.join(',');
  settings.env.WIKI_DEFAULT_ORG = defaultOrg;
  // Initialize empty project mapping (method a lazy: filled as projects used)
  if (!settings.env.WIKI_PROJECT_ORGS) {
    settings.env.WIKI_PROJECT_ORGS = '';
  }
  // Empty remote pattern mapping (method c: user fills as needed)
  if (!settings.env.WIKI_ORG_REMOTE_PATTERNS) {
    settings.env.WIKI_ORG_REMOTE_PATTERNS = '';
  }
  writeSettings(settings);
  console.log(`[wiki4-agent] WIKI_ORGS·WIKI_DEFAULT_ORG 주입 완료 (기본: ${defaultOrg})`);
  return selected;
}

async function promptProjectOrgsMapping(orgs, wikiPath) {
  const settings = readSettings();
  const existing = settings.env.WIKI_PROJECT_ORGS || '';

  // 이미 매핑 있으면 유지
  if (existing.length > 0) {
    console.log(`[wiki4-agent] WIKI_PROJECT_ORGS 유지: ${existing}`);
    return;
  }

  if (orgs.length === 1) {
    // 단일 org면 매핑 불필요 — 모든 프로젝트가 해당 org로 자동 귀속
    console.log(`[wiki4-agent] 단일 org(${orgs[0]}) — project→org 매핑 불필요`);
    return;
  }

  console.log('');
  console.log('  [WIKI_PROJECT_ORGS] (선택) 자주 쓰는 프로젝트를 org에 매핑해두면 hook이 자동 감지:');
  console.log(`  입력 형식: "project1=org1,project2=org2" (Enter로 건너뛰고 lazy로 위임 가능)`);
  console.log(`  예: pubgcom-app-front=Krafton,windless-app-front=Krafton`);
  console.log('');

  const mapping = (await prompt('  매핑 입력 (비우면 나중에 자동 감지/수동): ')).trim();
  if (!mapping) {
    console.log(`  → 매핑 비움. /wiki 첫 실행 시 자동 또는 수동 매핑.`);
    return;
  }

  // 간단 검증: project=org 형식, org가 선택 목록 안에 있는지
  const parts = mapping.split(',').map(s => s.trim()).filter(Boolean);
  const valid = [];
  for (const p of parts) {
    const m = p.match(/^([^=]+)=(.+)$/);
    if (!m) continue;
    const [, proj, org] = m;
    if (!orgs.includes(org)) {
      console.warn(`  ⚠ "${proj}"의 org="${org}"가 선택 목록에 없음 — 건너뜀`);
      continue;
    }
    valid.push(`${proj.trim()}=${org.trim()}`);
  }

  if (valid.length === 0) {
    console.log(`  → 유효한 매핑 없음. 나중에 자동 감지.`);
    return;
  }

  settings.env.WIKI_PROJECT_ORGS = valid.join(',');
  writeSettings(settings);
  console.log(`  → 매핑 ${valid.length}건 저장`);
}

// ---------- skills 심볼릭 링크 ----------

function linkOne(src, dest, label) {
  try {
    if (!fs.existsSync(src)) {
      console.warn(`[wiki4-agent] skip ${label}: 원본 없음 ${src}`);
      return { status: 'skip-no-src' };
    }
    const lstat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (!lstat) {
      fs.symlinkSync(src, dest);
      console.log(`[wiki4-agent] link ${label}`);
      return { status: 'linked' };
    }
    if (lstat.isSymbolicLink()) {
      const existing = fs.readlinkSync(dest);
      if (existing === src) return { status: 'already-linked' };
      fs.unlinkSync(dest);
      fs.symlinkSync(src, dest);
      console.log(`[wiki4-agent] relink ${label} (이전: ${existing})`);
      return { status: 'relinked' };
    }
    console.warn(
      `[wiki4-agent] conflict ${label}: 기존 파일/디렉토리 존재 → 건너뜀 (${dest})`
    );
    return { status: 'conflict' };
  } catch (err) {
    console.error(`[wiki4-agent] error ${label}: ${err.message}`);
    return { status: 'error' };
  }
}

// ---------- UserPromptSubmit hook 등록 ----------

function ensureHook() {
  try {
    if (!fs.existsSync(HOOK_SRC)) {
      console.warn('[wiki4-agent] hook 스크립트 없음, 건너뜀');
      return;
    }
    ensureDir(HOOK_DEST_DIR);

    // hook 스크립트 symlink
    const lstat = fs.lstatSync(HOOK_DEST, { throwIfNoEntry: false });
    if (!lstat) {
      fs.symlinkSync(HOOK_SRC, HOOK_DEST);
      console.log(`[wiki4-agent] hook link: ${HOOK_DEST}`);
    } else if (lstat.isSymbolicLink()) {
      if (fs.readlinkSync(HOOK_DEST) !== HOOK_SRC) {
        fs.unlinkSync(HOOK_DEST);
        fs.symlinkSync(HOOK_SRC, HOOK_DEST);
        console.log(`[wiki4-agent] hook relink: ${HOOK_DEST}`);
      }
    }

    // settings.json hooks.UserPromptSubmit 등록
    const settings = readSettings();
    settings.hooks = settings.hooks || {};
    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];

    // 중복 방지 — 이미 등록돼 있으면 스킵
    const hookEntry = {
      hooks: [{ type: 'command', command: HOOK_DEST }],
    };
    const alreadyRegistered = settings.hooks.UserPromptSubmit.some((e) =>
      e && e.hooks && e.hooks.some((h) => h && h.command === HOOK_DEST)
    );
    if (!alreadyRegistered) {
      settings.hooks.UserPromptSubmit.push(hookEntry);
      writeSettings(settings);
      console.log('[wiki4-agent] settings.json hooks.UserPromptSubmit 등록 완료');
    } else {
      console.log('[wiki4-agent] hooks.UserPromptSubmit 이미 등록됨');
    }
  } catch (err) {
    console.error(`[wiki4-agent] hook 설치 error: ${err.message}`);
  }
}

// ---------- Stop hook 등록 (인용 검증, 2026-04-29) ----------

function ensureCiteHook() {
  try {
    if (!fs.existsSync(CITE_HOOK_SRC)) {
      console.warn('[wiki4-agent] cite-verify hook 스크립트 없음, 건너뜀');
      return;
    }
    ensureDir(HOOK_DEST_DIR);

    // hook 스크립트 symlink
    const lstat = fs.lstatSync(CITE_HOOK_DEST, { throwIfNoEntry: false });
    if (!lstat) {
      fs.symlinkSync(CITE_HOOK_SRC, CITE_HOOK_DEST);
      console.log(`[wiki4-agent] cite-verify hook link: ${CITE_HOOK_DEST}`);
    } else if (lstat.isSymbolicLink()) {
      if (fs.readlinkSync(CITE_HOOK_DEST) !== CITE_HOOK_SRC) {
        fs.unlinkSync(CITE_HOOK_DEST);
        fs.symlinkSync(CITE_HOOK_SRC, CITE_HOOK_DEST);
        console.log(`[wiki4-agent] cite-verify hook relink: ${CITE_HOOK_DEST}`);
      }
    }

    // settings.json hooks.Stop 등록
    const settings = readSettings();
    settings.hooks = settings.hooks || {};
    settings.hooks.Stop = settings.hooks.Stop || [];

    const citeEntry = {
      hooks: [{ type: 'command', command: CITE_HOOK_DEST }],
    };
    const alreadyRegistered = settings.hooks.Stop.some((e) =>
      e && e.hooks && e.hooks.some((h) => h && h.command === CITE_HOOK_DEST)
    );
    if (!alreadyRegistered) {
      settings.hooks.Stop.push(citeEntry);
      writeSettings(settings);
      console.log('[wiki4-agent] settings.json hooks.Stop 등록 완료');
    } else {
      console.log('[wiki4-agent] hooks.Stop 이미 등록됨');
    }
  } catch (err) {
    console.error(`[wiki4-agent] cite-verify hook 설치 error: ${err.message}`);
  }
}

// ---------- auto-consult 템플릿 주입 ----------

function injectAutoConsult() {
  try {
    if (!fs.existsSync(AUTO_CONSULT_TEMPLATE)) {
      console.warn('[wiki4-agent] auto-consult template not found, skipping');
      return;
    }
    const block = fs.readFileSync(AUTO_CONSULT_TEMPLATE, 'utf8').trim();
    let existing = '';
    if (fs.existsSync(CLAUDE_MD)) existing = fs.readFileSync(CLAUDE_MD, 'utf8');

    // regex로 임의 버전 마커 매칭 — v0.1/v0.2/v0.3 모두
    const beginMatch = existing.match(MARKER_RE_BEGIN);
    const endMatch = existing.match(MARKER_RE_END);
    let next, mode;

    if (beginMatch && endMatch && endMatch.index > beginMatch.index) {
      const beginIdx = beginMatch.index;
      const endIdx = endMatch.index + endMatch[0].length;
      const before = existing.substring(0, beginIdx).replace(/\s+$/, '');
      const after = existing.substring(endIdx).replace(/^\s+/, '');
      next = [before, block, after].filter(Boolean).join('\n\n') + '\n';
      mode = 'updated';
    } else if (existing.trim().length === 0) {
      next = block + '\n';
      mode = 'created';
    } else {
      next = existing.replace(/\s+$/, '') + '\n\n' + block + '\n';
      mode = 'appended';
    }

    ensureDir(path.dirname(CLAUDE_MD));
    fs.writeFileSync(CLAUDE_MD, next, 'utf8');
    console.log(`[wiki4-agent] auto-consult: ${mode} in ~/.claude/CLAUDE.md`);
  } catch (err) {
    console.error(`[wiki4-agent] auto-consult injection error: ${err.message}`);
  }
}

// ---------- main ----------

function updateSummary(s, status) {
  switch (status) {
    case 'linked': s.linked++; break;
    case 'relinked': s.relinked++; break;
    case 'already-linked': s.alreadyLinked++; break;
    case 'conflict': s.conflict++; break;
    case 'error': s.error++; break;
    default: s.skip++;
  }
}

async function main() {
  console.log('[wiki4-agent] 설치 시작');
  console.log('');

  // 1) WIKI_PATH 보장
  const wikiPath = ensureWikiPath();

  // 2) WIKI_ORGS 인터랙티브 선택
  const orgs = await ensureOrgs();
  await promptProjectOrgsMapping(orgs, wikiPath);

  // 3) 스킬 심볼릭 링크
  ensureDir(DEST_SKILLS);
  const summary = { linked: 0, relinked: 0, alreadyLinked: 0, conflict: 0, error: 0, skip: 0 };
  if (fs.existsSync(SRC_SKILLS)) {
    for (const name of fs.readdirSync(SRC_SKILLS)) {
      const src = path.join(SRC_SKILLS, name);
      if (!fs.statSync(src).isDirectory()) continue;
      const dest = path.join(DEST_SKILLS, name);
      updateSummary(summary, linkOne(src, dest, `skills/${name}`).status);
    }
  }
  console.log(
    `[wiki4-agent] skills: linked=${summary.linked}, relinked=${summary.relinked}, ` +
    `already=${summary.alreadyLinked}, conflict=${summary.conflict}, ` +
    `error=${summary.error}, skip=${summary.skip}`
  );
  if (summary.conflict > 0) {
    console.warn(
      `[wiki4-agent] ${summary.conflict}개 충돌 — 기존 사용자 파일 보호. ` +
      `필요 시 수동 제거 후 "npm run install:manual" 재실행.`
    );
  }

  // 4) UserPromptSubmit hook 등록 (결정론적 wiki 주입)
  ensureHook();

  // 4-2) Stop hook 등록 (인용 검증, 2026-04-29 신규)
  ensureCiteHook();

  // 5) auto-consult 템플릿 주입 (보조 — hook과 별개로 CLAUDE.md에 가이드 남김)
  injectAutoConsult();

  const settings = readSettings();
  const defaultOrg = (settings.env && settings.env.WIKI_DEFAULT_ORG) || '-';
  const orgList = (settings.env && settings.env.WIKI_ORGS) || '-';
  const mapping = (settings.env && settings.env.WIKI_PROJECT_ORGS) || '';

  console.log('');
  console.log('[wiki4-agent] 설치 완료.');
  console.log('');
  console.log(`  WIKI_PATH         = ${wikiPath}`);
  console.log(`  WIKI_ORGS         = ${orgList}`);
  console.log(`  WIKI_DEFAULT_ORG  = ${defaultOrg}`);
  console.log(`  WIKI_PROJECT_ORGS = ${mapping || '(비어있음 — 자동 감지)'}`);
  console.log('');
  console.log('사용:');
  console.log('  cd <소스 레포> && claude');
  console.log('  (그냥 기술 질문) — Hook이 결정론적으로 wiki 참조 답변 형성·주입');
  console.log('  /wiki <파일>     — 인제스트 + 검증 게이트 + 자동 커밋');
  console.log('  /wiki-lint       — 독립 점검');
  console.log('  /wiki-resolve    — 판례 기반 실 파일 수정');
  console.log('');
  console.log(`wiki 저장 위치: $WIKI_PATH/<org>/<프로젝트명>/`);
  console.log(`  - project→org 매핑: settings.json env.WIKI_PROJECT_ORGS 확인`);
  console.log(`  - 매핑 없으면 WIKI_DEFAULT_ORG(${defaultOrg})로 자동 귀속`);
  console.log('');
  console.log('인용 검증 (2026-04-29 신규, 기본 활성):');
  console.log('  Stop hook이 매 답변 후 [[wiki-link]] 인용 실존 확인.');
  console.log('  깨진 인용 발견 시 다음 turn 컨텍스트에 한 줄 inject.');
  console.log('  비활성: export WIKI_CITE_VERIFY=0');
  console.log('  비용: 0 (Python 결정론, LLM 호출 없음).');
}

main().catch(err => {
  console.error('[wiki4-agent] 설치 중 오류:', err.message);
  process.exit(1);
});
