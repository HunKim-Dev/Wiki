#!/usr/bin/env node
// wiki4-agent preuninstall: 심볼릭 링크 + auto-consult 블록 제거.
// settings.json의 env.WIKI_PATH는 **보존** (재설치 시 재사용).

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PKG_ROOT = path.resolve(__dirname, '..');
const SRC_SKILLS = path.join(PKG_ROOT, 'skills');
const DEST_SKILLS = path.join(HOME, '.claude', 'skills');
const CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const HOOK_SRC = path.join(PKG_ROOT, 'scripts', 'hooks', 'wiki-auto-consult.py');
const HOOK_DEST = path.join(HOME, '.claude', 'hooks', 'wiki4-auto-consult.py');
// Stop hook (인용 검증, 2026-04-29 신규)
const CITE_HOOK_SRC = path.join(PKG_ROOT, 'scripts', 'hooks', 'wiki-cite-verify.py');
const CITE_HOOK_DEST = path.join(HOME, '.claude', 'hooks', 'wiki4-cite-verify.py');
// 구버전 audit-trigger (2026-04-29 일찍 만들었던 거, 정리용)
const OLD_AUDIT_HOOK_DEST = path.join(HOME, '.claude', 'hooks', 'wiki4-audit-trigger.py');
// 구버전 bash hook 정리용
const OLD_HOOK_SRC = path.join(PKG_ROOT, 'scripts', 'hooks', 'wiki-auto-consult.sh');
const OLD_HOOK_DEST = path.join(HOME, '.claude', 'hooks', 'wiki4-auto-consult.sh');
const MARKER_BEGIN = '<!-- wiki4-agent auto-consult v0.1 begin -->';
const MARKER_END = '<!-- wiki4-agent auto-consult v0.1 end -->';

function unlinkIfOurs(src, dest, label) {
  try {
    const lstat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (!lstat) return { status: 'not-found' };
    if (!lstat.isSymbolicLink()) {
      console.warn(`[wiki4-agent] skip ${label}: 심볼릭 링크 아님 (사용자 파일 보호) → ${dest}`);
      return { status: 'not-symlink' };
    }
    const target = fs.readlinkSync(dest);
    if (target !== src) {
      console.warn(`[wiki4-agent] skip ${label}: 우리 소스 아님 (${target}) → 건드리지 않음`);
      return { status: 'foreign-symlink' };
    }
    fs.unlinkSync(dest);
    console.log(`[wiki4-agent] unlink ${label}`);
    return { status: 'unlinked' };
  } catch (err) {
    console.error(`[wiki4-agent] error ${label}: ${err.message}`);
    return { status: 'error' };
  }
}

function removeAutoConsult() {
  try {
    if (!fs.existsSync(CLAUDE_MD)) return;
    const existing = fs.readFileSync(CLAUDE_MD, 'utf8');
    const beginIdx = existing.indexOf(MARKER_BEGIN);
    const endIdx = existing.indexOf(MARKER_END);
    if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return;

    const before = existing.substring(0, beginIdx).replace(/\s+$/, '');
    const after = existing.substring(endIdx + MARKER_END.length).replace(/^\s+/, '');
    const remaining = [before, after].filter(Boolean).join('\n\n').trim();

    if (remaining.length === 0) {
      fs.unlinkSync(CLAUDE_MD);
      console.log('[wiki4-agent] auto-consult 제거 + 빈 ~/.claude/CLAUDE.md 삭제');
    } else {
      fs.writeFileSync(CLAUDE_MD, remaining + '\n', 'utf8');
      console.log('[wiki4-agent] auto-consult 제거 (사용자 기타 내용 보존)');
    }
  } catch (err) {
    console.error(`[wiki4-agent] auto-consult removal error: ${err.message}`);
  }
}

function updateSummary(s, status) {
  switch (status) {
    case 'unlinked': s.unlinked++; break;
    case 'not-found': s.notFound++; break;
    case 'not-symlink': s.notSymlink++; break;
    case 'foreign-symlink': s.foreign++; break;
    case 'error': s.error++; break;
  }
}

function removeHook() {
  // 1) hook 심볼릭 링크 제거
  unlinkIfOurs(HOOK_SRC, HOOK_DEST, `hooks/wiki4-auto-consult.py`);
  unlinkIfOurs(CITE_HOOK_SRC, CITE_HOOK_DEST, `hooks/wiki4-cite-verify.py`);
  unlinkIfOurs(OLD_HOOK_SRC, OLD_HOOK_DEST, `hooks/wiki4-auto-consult.sh (구버전)`);
  // 구버전 audit-trigger 정리 (있으면)
  if (fs.existsSync(OLD_AUDIT_HOOK_DEST)) {
    try {
      fs.unlinkSync(OLD_AUDIT_HOOK_DEST);
      console.log(`[wiki4-agent] cleanup: hooks/wiki4-audit-trigger.py (구버전)`);
    } catch (err) {}
  }

  // 2) settings.json에서 hook 엔트리 제거 (UserPromptSubmit + Stop)
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!settings.hooks) return;

    let totalRemoved = 0;

    // UserPromptSubmit 제거
    if (Array.isArray(settings.hooks.UserPromptSubmit)) {
      const before = settings.hooks.UserPromptSubmit.length;
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter((e) => {
        if (!e || !Array.isArray(e.hooks)) return true;
        return !e.hooks.some((h) => h && (h.command === HOOK_DEST || h.command === OLD_HOOK_DEST));
      });
      totalRemoved += before - settings.hooks.UserPromptSubmit.length;
      if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;
    }

    // Stop 제거 (인용 검증 + 구버전 audit-trigger)
    if (Array.isArray(settings.hooks.Stop)) {
      const before = settings.hooks.Stop.length;
      settings.hooks.Stop = settings.hooks.Stop.filter((e) => {
        if (!e || !Array.isArray(e.hooks)) return true;
        return !e.hooks.some((h) => h && (h.command === CITE_HOOK_DEST || h.command === OLD_AUDIT_HOOK_DEST));
      });
      totalRemoved += before - settings.hooks.Stop.length;
      if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    }

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    if (totalRemoved > 0) {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
      console.log(`[wiki4-agent] settings.json hook 엔트리 ${totalRemoved}개 제거`);
    }
  } catch (err) {
    console.error(`[wiki4-agent] hook 제거 error: ${err.message}`);
  }
}

function main() {
  const summary = { unlinked: 0, notFound: 0, notSymlink: 0, foreign: 0, error: 0 };

  if (fs.existsSync(SRC_SKILLS)) {
    for (const name of fs.readdirSync(SRC_SKILLS)) {
      const src = path.join(SRC_SKILLS, name);
      if (!fs.statSync(src).isDirectory()) continue;
      const dest = path.join(DEST_SKILLS, name);
      updateSummary(summary, unlinkIfOurs(src, dest, `skills/${name}`).status);
    }
  }

  console.log(
    `[wiki4-agent] uninstall: unlinked=${summary.unlinked}, not-found=${summary.notFound}, ` +
    `user-file=${summary.notSymlink}, foreign=${summary.foreign}, error=${summary.error}`
  );

  removeHook();
  removeAutoConsult();

  console.log('[wiki4-agent] 완료. settings.json의 env.WIKI_PATH는 보존됩니다.');
}

main();
