#!/usr/bin/env node
// wiki-for-claude postinstall:
//   1) WIKI_PATH 자동 감지 → ~/.claude/settings.json env.WIKI_PATH 주입
//   2) WIKI_ORGS 인터랙티브 선택 → settings.json env.WIKI_ORGS / WIKI_DEFAULT_ORG
//   3) skills/*/ → ~/.claude/skills/*/ 심볼릭 링크
//   4) UserPromptSubmit hook 등록
//   5) ~/.claude/CLAUDE.md에 auto-consult 블록 주입
//
// 사용자는 매 세션 export 할 필요 없음 — settings.json의 env가 Claude Code 시작 시 자동 적용.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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
const HOOK_DEST = path.join(HOOK_DEST_DIR, 'wiki-auto-consult.py');
// Stop hook (인용 검증, 2026-04-29 신규)
const CITE_HOOK_SRC = path.join(PKG_ROOT, 'scripts', 'hooks', 'wiki-cite-verify.py');
const CITE_HOOK_DEST = path.join(HOOK_DEST_DIR, 'wiki-cite-verify.py');
// v0.1 이전 이름. 중복 등록·유령 심볼릭 링크를 막기 위해 설치 때 정리한다.
const LEGACY_HOOK_DESTS = [
  path.join(HOOK_DEST_DIR, 'wiki4-auto-consult.py'),
  path.join(HOOK_DEST_DIR, 'wiki4-cite-verify.py'),
  path.join(HOOK_DEST_DIR, 'wiki4-auto-consult.sh'),
  path.join(HOOK_DEST_DIR, 'wiki4-audit-trigger.py'),
];
// 구·신 버전 마커 모두 매칭 (regex)
const MARKER_RE_BEGIN = /<!--\s*(?:wiki4?-agent|wiki-for-claude) auto-consult v\d+\.\d+ begin\s*-->/;
const MARKER_RE_END = /<!--\s*(?:wiki4?-agent|wiki-for-claude) auto-consult v\d+\.\d+ end\s*-->/;

const WIKI_PATH_CANDIDATES = [
  path.join(HOME, 'wiki-docs'),
  path.join(HOME, 'WorkSpace', 'wiki-docs'),
  path.join(HOME, 'workspace', 'wiki-docs'),
  path.join(HOME, 'Documents', 'wiki-docs'),
  path.join(HOME, 'Projects', 'wiki-docs'),
  path.join(HOME, 'projects', 'wiki-docs'),
  path.join(HOME, 'Code', 'wiki-docs'),
  path.join(HOME, 'code', 'wiki-docs'),
  path.join(HOME, 'Dev', 'wiki-docs'),
  path.join(HOME, 'dev', 'wiki-docs'),
  path.join(HOME, 'src', 'wiki-docs'),
  path.join(HOME, 'wiki-data'),
  // v0.1 이전 기본 폴더명. 기존 사용자가 재설치해도 그대로 찾아가도록 남겨둔다.
  path.join(HOME, 'WorkSpace', 'wiki4docs'),
  path.join(HOME, 'wiki4docs'),
];
const DEFAULT_WIKI_PATH = path.join(HOME, 'wiki-docs');

// 그룹 목록은 하드코딩하지 않는다 — 설치 시 사용자가 직접 입력한다.
// 입력이 없고 git remote도 못 읽으면 이 이름 하나로 시작한다.
const FALLBACK_ORG = 'Personal';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// npm postinstall은 CI·자동화에서 TTY 없이 돌 수 있다. 그때는 절대 멈추지 않는다.
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// "~/foo" · 상대경로 → 절대경로
function expandPath(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw === '~') return HOME;
  if (raw.startsWith('~/')) return path.resolve(HOME, raw.slice(2));
  return path.resolve(raw);
}

// 출력용 축약 — 사용자 홈 경로를 그대로 노출하지 않는다
function tildify(p) {
  return p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

// 그룹 이름은 그대로 폴더 이름이 된다 — 경로 구분자·상위 이동 차단
function sanitizeOrg(name) {
  const v = String(name || '').trim();
  if (!v || v === '.' || v === '..') return '';
  if (/[\\/]/.test(v)) return '';
  return v;
}

// 설치를 실행한 폴더의 git remote에서 org를 추측 (예: github.com/acme/repo → acme)
function guessOrgFromGitRemote() {
  const cwd = process.env.INIT_CWD || process.cwd();
  try {
    const url = execSync('git config --get remote.origin.url', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (!url) return '';
    const m = url.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
    return m ? sanitizeOrg(m[1]) : '';
  } catch (err) {
    return '';
  }
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
    console.error(`[wiki] ${SETTINGS_FILE} 파싱 실패 (${e.message}) → 백업: ${backup}`);
    fs.copyFileSync(SETTINGS_FILE, backup);
    return {};
  }
}

function writeSettings(data) {
  ensureDir(path.dirname(SETTINGS_FILE));
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function ensureWikiPath() {
  const settings = readSettings();
  const existingPath = settings.env && settings.env.WIKI_PATH;

  if (existingPath && fs.existsSync(existingPath) && fs.statSync(existingPath).isDirectory()) {
    // 패키지 위치는 재설치마다 달라질 수 있으므로 ENGINE_ROOT는 항상 갱신.
    settings.env.WIKI_ENGINE_ROOT = PKG_ROOT;
    writeSettings(settings);
    console.log(`[wiki] WIKI_PATH 유지: ${tildify(existingPath)}`);
    return existingPath;
  }

  const suggested = discoverWikiPath() || DEFAULT_WIKI_PATH;
  let chosen = suggested;

  if (isInteractive()) {
    console.log('');
    console.log('  [WIKI_PATH] 위키 마크다운을 저장할 폴더를 지정하세요.');
    console.log('  소스 레포와 분리된 곳을 권장합니다 — 패키지를 지워도 위키는 남습니다.');
    const answer = await prompt(`  저장 폴더 [${tildify(suggested)}]: `);
    chosen = expandPath(answer) || suggested;
  } else {
    console.log(`[wiki] 비대화형 — WIKI_PATH 기본값 사용: ${tildify(chosen)}`);
  }

  if (fs.existsSync(chosen)) {
    console.log(`  → 기존 폴더 사용: ${tildify(chosen)}`);
  } else {
    ensureDir(chosen);
    console.log(`  → 새로 생성: ${tildify(chosen)}`);
  }

  settings.env = settings.env || {};
  settings.env.WIKI_PATH = chosen;
  settings.env.WIKI_ENGINE_ROOT = PKG_ROOT;
  writeSettings(settings);
  console.log(`[wiki] ~/.claude/settings.json env.WIKI_PATH 주입 완료`);
  return chosen;
}

// ---------- WIKI_ORGS 인터랙티브 선택 ----------

async function ensureOrgs() {
  const settings = readSettings();
  const existingOrgs = settings.env && settings.env.WIKI_ORGS;

  if (existingOrgs) {
    const orgList = existingOrgs.split(',').map((v) => v.trim()).filter(Boolean);
    console.log(`[wiki] WIKI_ORGS 유지: ${orgList.join(', ')}`);
    return orgList;
  }

  // 그룹 목록을 미리 정해두지 않는다. git remote에서 추측한 값을 제안만 한다.
  const guessed = guessOrgFromGitRemote();
  let selected = [guessed || FALLBACK_ORG];

  if (isInteractive()) {
    console.log('');
    console.log('  [WIKI_ORGS] 위키를 나눌 "그룹" 이름을 직접 입력하세요.');
    console.log('  회사·팀·클라이언트·개인 등 프로젝트를 묶는 단위면 무엇이든 됩니다.');
    console.log('  그룹은 그대로 폴더 이름이 됩니다 — <저장 폴더>/<그룹>/<프로젝트>/wiki/');
    console.log('');
    const hint = guessed ? `git remote에서 감지: ${guessed}` : FALLBACK_ORG;
    const raw = await prompt(`  그룹 이름 (쉼표 구분) [${hint}]: `);
    const typed = [...new Set(raw.split(',').map(sanitizeOrg).filter(Boolean))];
    if (typed.length > 0) selected = typed;
    console.log(`  → 그룹: ${selected.join(', ')}`);
  } else {
    console.log(`[wiki] 비대화형 — WIKI_ORGS 기본값 사용: ${selected.join(', ')}`);
  }

  let defaultOrg = selected[0];
  if (selected.length > 1 && isInteractive()) {
    const answer = (await prompt(`  기본 그룹 [${defaultOrg}]: `)).trim();
    if (selected.includes(answer)) {
      defaultOrg = answer;
    } else if (answer) {
      console.log(`  ⚠ "${answer}"는 입력한 그룹에 없음 — ${defaultOrg} 유지`);
    }
  }

  settings.env = settings.env || {};
  settings.env.WIKI_ORGS = selected.join(',');
  settings.env.WIKI_DEFAULT_ORG = defaultOrg;
  if (!settings.env.WIKI_PROJECT_ORGS) {
    settings.env.WIKI_PROJECT_ORGS = '';
  }
  if (!settings.env.WIKI_ORG_REMOTE_PATTERNS) {
    settings.env.WIKI_ORG_REMOTE_PATTERNS = '';
  }
  writeSettings(settings);
  console.log(`[wiki] WIKI_ORGS = ${selected.join(',')} (기본: ${defaultOrg})`);
  return selected;
}

async function promptProjectOrgsMapping(orgs, wikiPath) {
  const settings = readSettings();
  const existing = settings.env.WIKI_PROJECT_ORGS || '';

  // 이미 매핑 있으면 유지
  if (existing.length > 0) {
    console.log(`[wiki] WIKI_PROJECT_ORGS 유지: ${existing}`);
    return;
  }

  if (orgs.length === 1) {
    // 단일 org면 매핑 불필요 — 모든 프로젝트가 해당 org로 자동 귀속
    console.log(`[wiki] 단일 org(${orgs[0]}) — project→org 매핑 불필요`);
    return;
  }

  if (!isInteractive()) {
    console.log('[wiki] 비대화형 — project→그룹 매핑 건너뜀 (/wiki-config로 추가)');
    return;
  }

  console.log('');
  console.log('  [WIKI_PROJECT_ORGS] (선택) 자주 쓰는 프로젝트를 그룹에 매핑해두면 hook이 자동 감지:');
  console.log(`  입력 형식: "project1=group1,project2=group2" (Enter로 건너뛰고 나중에 지정 가능)`);
  console.log(`  예: web-front=${orgs[0]},api-server=${orgs[orgs.length - 1]}`);
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
      console.warn(`  ⚠ "${proj}"의 그룹 "${org}"가 입력한 그룹에 없음 — 건너뜀`);
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
      console.warn(`[wiki] skip ${label}: 원본 없음 ${src}`);
      return { status: 'skip-no-src' };
    }
    const lstat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (!lstat) {
      fs.symlinkSync(src, dest);
      console.log(`[wiki] link ${label}`);
      return { status: 'linked' };
    }
    if (lstat.isSymbolicLink()) {
      const existing = fs.readlinkSync(dest);
      if (existing === src) return { status: 'already-linked' };
      fs.unlinkSync(dest);
      fs.symlinkSync(src, dest);
      console.log(`[wiki] relink ${label} (이전: ${existing})`);
      return { status: 'relinked' };
    }
    console.warn(
      `[wiki] conflict ${label}: 기존 파일/디렉토리 존재 → 건너뜀 (${dest})`
    );
    return { status: 'conflict' };
  } catch (err) {
    console.error(`[wiki] error ${label}: ${err.message}`);
    return { status: 'error' };
  }
}

// ---------- 구버전(wiki4-*) 잔재 정리 ----------

// 이름이 바뀌기 전 설치본이 남아 있으면 hook이 두 번 등록돼 중복 실행된다.
function cleanupLegacy() {
  for (const dest of LEGACY_HOOK_DESTS) {
    try {
      const lstat = fs.lstatSync(dest, { throwIfNoEntry: false });
      if (!lstat) continue;
      if (!lstat.isSymbolicLink()) {
        console.warn(`[wiki] skip 구버전 정리: 심볼릭 링크 아님 → ${dest}`);
        continue;
      }
      fs.unlinkSync(dest);
      console.log(`[wiki] 구버전 정리: ${path.basename(dest)}`);
    } catch (err) {
      console.error(`[wiki] 구버전 정리 error: ${err.message}`);
    }
  }

  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const settings = readSettings();
    if (!settings.hooks) return;
    let removed = 0;
    for (const event of ['UserPromptSubmit', 'Stop']) {
      const list = settings.hooks[event];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((e) => {
        const cmds = (e && e.hooks) || [];
        const isLegacy = cmds.some((h) => h && LEGACY_HOOK_DESTS.includes(h.command));
        if (isLegacy) removed++;
        return !isLegacy;
      });
      if (kept.length !== list.length) settings.hooks[event] = kept;
    }
    if (removed > 0) {
      writeSettings(settings);
      console.log(`[wiki] settings.json 구버전 hook 엔트리 ${removed}개 제거`);
    }
  } catch (err) {
    console.error(`[wiki] 구버전 hook 엔트리 정리 error: ${err.message}`);
  }
}

// ---------- UserPromptSubmit hook 등록 ----------

function ensureHook() {
  try {
    if (!fs.existsSync(HOOK_SRC)) {
      console.warn('[wiki] hook 스크립트 없음, 건너뜀');
      return;
    }
    ensureDir(HOOK_DEST_DIR);

    // hook 스크립트 symlink
    const lstat = fs.lstatSync(HOOK_DEST, { throwIfNoEntry: false });
    if (!lstat) {
      fs.symlinkSync(HOOK_SRC, HOOK_DEST);
      console.log(`[wiki] hook link: ${HOOK_DEST}`);
    } else if (lstat.isSymbolicLink()) {
      if (fs.readlinkSync(HOOK_DEST) !== HOOK_SRC) {
        fs.unlinkSync(HOOK_DEST);
        fs.symlinkSync(HOOK_SRC, HOOK_DEST);
        console.log(`[wiki] hook relink: ${HOOK_DEST}`);
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
      console.log('[wiki] settings.json hooks.UserPromptSubmit 등록 완료');
    } else {
      console.log('[wiki] hooks.UserPromptSubmit 이미 등록됨');
    }
  } catch (err) {
    console.error(`[wiki] hook 설치 error: ${err.message}`);
  }
}

// ---------- Stop hook 등록 (인용 검증, 2026-04-29) ----------

function ensureCiteHook() {
  try {
    if (!fs.existsSync(CITE_HOOK_SRC)) {
      console.warn('[wiki] cite-verify hook 스크립트 없음, 건너뜀');
      return;
    }
    ensureDir(HOOK_DEST_DIR);

    // hook 스크립트 symlink
    const lstat = fs.lstatSync(CITE_HOOK_DEST, { throwIfNoEntry: false });
    if (!lstat) {
      fs.symlinkSync(CITE_HOOK_SRC, CITE_HOOK_DEST);
      console.log(`[wiki] cite-verify hook link: ${CITE_HOOK_DEST}`);
    } else if (lstat.isSymbolicLink()) {
      if (fs.readlinkSync(CITE_HOOK_DEST) !== CITE_HOOK_SRC) {
        fs.unlinkSync(CITE_HOOK_DEST);
        fs.symlinkSync(CITE_HOOK_SRC, CITE_HOOK_DEST);
        console.log(`[wiki] cite-verify hook relink: ${CITE_HOOK_DEST}`);
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
      console.log('[wiki] settings.json hooks.Stop 등록 완료');
    } else {
      console.log('[wiki] hooks.Stop 이미 등록됨');
    }
  } catch (err) {
    console.error(`[wiki] cite-verify hook 설치 error: ${err.message}`);
  }
}

// ---------- auto-consult 템플릿 주입 ----------

function injectAutoConsult() {
  try {
    if (!fs.existsSync(AUTO_CONSULT_TEMPLATE)) {
      console.warn('[wiki] auto-consult template not found, skipping');
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
    console.log(`[wiki] auto-consult: ${mode} in ~/.claude/CLAUDE.md`);
  } catch (err) {
    console.error(`[wiki] auto-consult injection error: ${err.message}`);
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
  console.log('[wiki] 설치 시작');
  console.log('');

  // 0) 구버전(wiki4-*) 잔재 정리 — 중복 hook 실행 방지
  cleanupLegacy();

  // 1) WIKI_PATH 보장
  const wikiPath = await ensureWikiPath();

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
    `[wiki] skills: linked=${summary.linked}, relinked=${summary.relinked}, ` +
    `already=${summary.alreadyLinked}, conflict=${summary.conflict}, ` +
    `error=${summary.error}, skip=${summary.skip}`
  );
  if (summary.conflict > 0) {
    console.warn(
      `[wiki] ${summary.conflict}개 충돌 — 기존 사용자 파일 보호. ` +
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
  console.log('[wiki] 설치 완료.');
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
  console.error('[wiki] 설치 중 오류:', err.message);
  process.exit(1);
});
