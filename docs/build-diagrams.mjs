#!/usr/bin/env node
/**
 * README 다이어그램 생성기.
 *
 * 하나의 정의에서 light / dark 두 벌의 SVG를 뽑아 docs/assets/ 에 쓴다.
 * README는 <picture> + prefers-color-scheme 으로 둘을 전환한다.
 *
 * 사용: node docs/build-diagrams.mjs
 *
 * 주의: GitHub은 레포 SVG를 sanitize하면서 <style> 블록을 제거할 수 있다.
 *       따라서 모든 스타일은 presentation attribute로 인라인하고,
 *       화살표 머리도 <marker> 대신 <path> 폴리곤으로 직접 그린다.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'assets');

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo','Noto Sans KR',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

const THEMES = {
  light: {
    bg: '#ffffff', surface: '#f6f8fa', card: '#ffffff',
    border: '#d0d7de', text: '#1f2328', muted: '#59636e', line: '#8c959f',
    blue: '#0969da', blueBg: '#ddf4ff', blueBorder: '#54aeff',
    orange: '#9a4600', orangeBg: '#fff1e5', orangeBorder: '#f5a97b',
    green: '#1a7f37', greenBg: '#dafbe1', greenBorder: '#6fdd8b',
    purple: '#8250df', purpleBg: '#fbefff', purpleBorder: '#c297ff',
    amber: '#7d4e00', amberBg: '#fff8c5', amberBorder: '#d4a72c',
  },
  dark: {
    bg: '#0d1117', surface: '#161b22', card: '#12171e',
    border: '#30363d', text: '#e6edf3', muted: '#9198a1', line: '#6e7681',
    blue: '#79c0ff', blueBg: '#0d2847', blueBorder: '#1f6feb',
    orange: '#ffa657', orangeBg: '#2d1a0b', orangeBorder: '#9e5622',
    green: '#56d364', greenBg: '#0f2916', greenBorder: '#238636',
    purple: '#d2a8ff', purpleBg: '#1d1436', purpleBorder: '#6e40c9',
    amber: '#e3b341', amberBg: '#2b2111', amberBorder: '#9e6a03',
  },
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- primitives ---------- */

const rect = ({ x, y, w, h, fill, stroke, r = 10, dash }) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}"`
  + (stroke ? ` stroke="${stroke}" stroke-width="1.4"` : '')
  + (dash ? ` stroke-dasharray="${dash}"` : '') + '/>';

const txt = ({ x, y, s, size = 13, fill, anchor = 'middle', weight = 400, mono = false, opacity }) =>
  `<text x="${x}" y="${y}" font-family="${mono ? MONO : SANS}" font-size="${size}"`
  + ` fill="${fill}" text-anchor="${anchor}" font-weight="${weight}"`
  + (opacity ? ` opacity="${opacity}"` : '') + `>${esc(s)}</text>`;

/** 여러 줄 텍스트를 같은 x에 순서대로 쌓는다. */
const lines = ({ x, y, gap = 17, items, anchor = 'middle' }) =>
  items.map((it, i) => txt({
    x, y: y + i * gap, s: it.s, size: it.size ?? 12,
    fill: it.fill, anchor: it.anchor ?? anchor, weight: it.weight ?? 400, mono: it.mono,
  })).join('');

const head = (x, y, dir, c) => {
  const a = 5.5, b = 9;
  const pts = {
    down: `${x - a},${y - b} ${x},${y} ${x + a},${y - b}`,
    up: `${x - a},${y + b} ${x},${y} ${x + a},${y + b}`,
    right: `${x - b},${y - a} ${x},${y} ${x - b},${y + a}`,
    left: `${x + b},${y - a} ${x},${y} ${x + b},${y + a}`,
  }[dir];
  return `<polygon points="${pts}" fill="${c}"/>`;
};

const arrow = ({ x1, y1, x2, y2, c, dash, dir }) => {
  const d = dir ?? (y1 === y2 ? (x2 > x1 ? 'right' : 'left') : (y2 > y1 ? 'down' : 'up'));
  const back = { down: [0, -7], up: [0, 7], right: [-7, 0], left: [7, 0] }[d];
  return `<line x1="${x1}" y1="${y1}" x2="${x2 + back[0]}" y2="${y2 + back[1]}" stroke="${c}"`
    + ` stroke-width="1.7" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
    + head(x2, y2, d, c);
};

/** 꺾인 경로. pts = [[x,y], ...], 마지막 점에 dir 방향 화살촉. */
const elbow = ({ pts, c, dir, dash }) => {
  const last = pts[pts.length - 1];
  const back = { down: [0, -7], up: [0, 7], right: [-7, 0], left: [7, 0] }[dir];
  const adj = [...pts.slice(0, -1), [last[0] + back[0], last[1] + back[1]]];
  const d = adj.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  return `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round"`
    + ` stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
    + head(last[0], last[1], dir, c);
};

/** 제목 + 설명줄을 가진 표준 노드 박스. */
const node = ({ x, y, w, h, fill, stroke, title, titleFill, titleSize = 15, titleMono, subs = [], subFill, r = 12 }) => {
  const cx = x + w / 2;
  let out = rect({ x, y, w, h, fill, stroke, r });
  const blockH = 0 + (subs.length ? subs.length * 17 : 0);
  const top = y + (h - (titleSize + 6 + blockH)) / 2 + titleSize;
  out += txt({ x: cx, y: top, s: title, size: titleSize, fill: titleFill, weight: 600, mono: titleMono });
  if (subs.length) {
    out += lines({
      x: cx, y: top + 21,
      items: subs.map((s) => (typeof s === 'string' ? { s, fill: subFill } : { ...s, fill: s.fill ?? subFill })),
    });
  }
  return out;
};

/* ---------- diagrams ---------- */

const D = {};

/* 1. 요청 1회의 생애주기 */
D['pipeline'] = (t) => {
  const W = 900, H = 636;
  const cx = 470, bx = 268, bw = 404;
  let g = '';

  // 왼쪽: wiki 저장소
  g += rect({ x: 24, y: 140, w: 190, h: 116, fill: t.surface, stroke: t.border });
  g += txt({ x: 119, y: 166, s: '$WIKI_PATH', size: 13, fill: t.text, weight: 700, mono: true });
  g += lines({
    x: 119, y: 188, gap: 16, items: [
      { s: '<Group>/<Project>/wiki/', fill: t.muted, size: 11, mono: true },
      { s: 'concepts · entities', fill: t.muted, size: 11 },
      { s: 'decisions · actions', fill: t.muted, size: 11 },
      { s: '.wiki4-index.json', fill: t.muted, size: 11, mono: true },
    ],
  });

  // 중앙 파이프라인
  g += node({ x: bx, y: 24, w: bw, h: 48, fill: t.card, stroke: t.border, title: '사용자 프롬프트', titleSize: 14, titleFill: t.text });
  g += arrow({ x1: cx, y1: 72, x2: cx, y2: 106, c: t.line });

  g += node({
    x: bx, y: 106, w: bw, h: 120, fill: t.blueBg, stroke: t.blueBorder,
    title: '① wiki-auto-consult.py', titleMono: true, titleFill: t.blue, subs: [
      { s: 'UserPromptSubmit hook · Python · 결정론 · < 200ms', fill: t.blue, size: 11 },
      { s: '키워드 추출 → 의도 감지 → org-wide 랭킹', fill: t.text },
      { s: '→ wiki 컨텍스트를 프롬프트에 주입', fill: t.text },
    ],
  });
  g += arrow({ x1: cx, y1: 226, x2: cx, y2: 260, c: t.line });

  g += node({
    x: bx, y: 260, w: bw, h: 120, fill: t.orangeBg, stroke: t.orangeBorder,
    title: '② Main Claude', titleFill: t.orange, subs: [
      { s: '주입된 wiki 컨텍스트만 근거로 답변', fill: t.text },
      { s: '[[wiki-link]] 인용 의무 · 없으면 “없음” 명시', fill: t.text },
      { s: '모드에 맞는 4지선다 출력', fill: t.text },
    ],
  });
  g += arrow({ x1: cx, y1: 380, x2: cx, y2: 414, c: t.line });

  g += node({
    x: bx, y: 414, w: bw, h: 110, fill: t.greenBg, stroke: t.greenBorder,
    title: '③ wiki-cite-verify.py', titleMono: true, titleFill: t.green, subs: [
      { s: 'Stop hook · Python · 결정론 · < 50ms · 토큰 0', fill: t.green, size: 11 },
      { s: 'V1 깨진 인용 · V2 인용 누락 검사', fill: t.text },
    ],
  });
  g += arrow({ x1: cx, y1: 524, x2: cx, y2: 558, c: t.line });
  g += node({ x: bx, y: 558, w: bw, h: 50, fill: t.card, stroke: t.border, title: '답변 + 위반 시 ⚠️ 경고 한 줄', titleSize: 14, titleFill: t.text });

  // wiki → hook (읽기)
  g += arrow({ x1: 216, y1: 176, x2: bx - 2, y2: 176, c: t.line, dash: '4 4' });
  g += txt({ x: 241, y: 166, s: '매칭 검색', size: 10, fill: t.muted });
  g += elbow({ pts: [[119, 256], [119, 470], [bx - 2, 470]], c: t.line, dir: 'right', dash: '4 4' });
  g += txt({ x: 192, y: 462, s: '실존 확인', size: 10, fill: t.muted });

  // 오른쪽: signals
  g += rect({ x: 690, y: 122, w: 186, h: 158, fill: t.surface, stroke: t.border });
  g += txt({ x: 706, y: 146, s: 'signals', size: 12, fill: t.text, weight: 700, anchor: 'start', mono: true });
  g += txt({ x: 706, y: 162, s: 'hook → Claude 지시', size: 10, fill: t.muted, anchor: 'start' });
  g += lines({
    x: 706, y: 184, gap: 17, anchor: 'start', items: [
      { s: 'scope=org-wide', fill: t.blue, size: 10.5, mono: true },
      { s: 'precedent-likely=true', fill: t.blue, size: 10.5, mono: true },
      { s: 'work-intent=true', fill: t.blue, size: 10.5, mono: true },
      { s: 'cross-top=<proj>', fill: t.blue, size: 10.5, mono: true },
      { s: 'unmapped-project=…', fill: t.blue, size: 10.5, mono: true },
    ],
  });
  g += arrow({ x1: 688, y1: 200, x2: 676, y2: 200, c: t.line, dir: 'left' });

  // 오른쪽: 경고
  g += rect({ x: 690, y: 414, w: 186, h: 110, fill: t.surface, stroke: t.border });
  g += txt({ x: 706, y: 438, s: 'stderr 경고', size: 12, fill: t.text, weight: 700, anchor: 'start' });
  g += lines({
    x: 706, y: 462, gap: 18, anchor: 'start', items: [
      { s: 'V1  없는 페이지 인용', fill: t.muted, size: 11 },
      { s: 'V2  인용 0건 (정책 위반)', fill: t.muted, size: 11 },
      { s: '정상이면 아무것도 안 뜸', fill: t.muted, size: 10.5 },
    ],
  });
  g += arrow({ x1: 676, y1: 469, x2: 688, y2: 469, c: t.line, dir: 'right' });

  return { W, H, g };
};

/* 2. auto-consult 내부 */
D['auto-consult'] = (t) => {
  const W = 900, H = 546;
  let g = '';

  g += rect({ x: 24, y: 20, w: 420, h: 486, fill: t.surface, stroke: t.border });
  g += txt({ x: 44, y: 46, s: 'wiki-auto-consult.py', size: 13, fill: t.text, weight: 700, anchor: 'start', mono: true });
  g += txt({ x: 44, y: 62, s: 'UserPromptSubmit — 매 프롬프트마다 무조건 실행', size: 10.5, fill: t.muted, anchor: 'start' });

  const steps = [
    ['① activation 체크', 'WIKI_AUTOCONSULT · 엔진 레포 가드 · wiki 존재'],
    ['② project · group 해석', 'git toplevel → PROJECT_ORGS → remote 패턴 → default'],
    ['③ 키워드 추출', '한국어 · 영어 토큰화 + STOPWORDS 제외'],
    ['④ 의도 감지', 'work-intent(“만들어줘”) vs 질문(“어떻게 구현됐어?”)'],
    ['⑤ org-wide 랭킹', 'inverted index → 없으면 grep · 현재 프로젝트 ×1.5'],
    ['⑥ signals 산출', 'scope · precedent-likely · work-intent · cross-top'],
  ];
  steps.forEach(([a, b], i) => {
    const y = 78 + i * 70;
    g += rect({ x: 40, y, w: 388, h: 58, fill: t.card, stroke: t.border, r: 9 });
    g += txt({ x: 58, y: y + 24, s: a, size: 12.5, fill: t.text, weight: 600, anchor: 'start' });
    g += txt({ x: 58, y: y + 42, s: b, size: 10.5, fill: t.muted, anchor: 'start' });
    if (i < steps.length - 1) g += arrow({ x1: 234, y1: y + 58, x2: 234, y2: y + 70, c: t.line });
  });

  // 입력: wiki 저장소
  g += rect({ x: 500, y: 30, w: 376, h: 84, fill: t.surface, stroke: t.border });
  g += txt({ x: 520, y: 56, s: '$WIKI_PATH  (읽기 전용)', size: 12.5, fill: t.text, weight: 700, anchor: 'start', mono: true });
  g += txt({ x: 520, y: 76, s: '<Group>/**/wiki/*.md  ·  .wiki4-index.json', size: 11, fill: t.muted, anchor: 'start', mono: true });
  g += txt({ x: 520, y: 96, s: 'hook은 절대 쓰지 않는다 — 저장은 /wiki 명시 호출만', size: 10.5, fill: t.muted, anchor: 'start' });
  g += arrow({ x1: 498, y1: 72, x2: 448, y2: 72, c: t.line, dir: 'left', dash: '4 4' });
  g += txt({ x: 473, y: 62, s: '매칭 검색', size: 10, fill: t.muted });

  // 출력: 주입 payload
  g += rect({ x: 500, y: 176, w: 376, h: 236, fill: t.blueBg, stroke: t.blueBorder });
  g += txt({ x: 520, y: 204, s: 'additionalContext 주입', size: 13.5, fill: t.blue, weight: 700, anchor: 'start' });
  g += txt({ x: 520, y: 222, s: '사용자 프롬프트 앞에 병합되어 Claude에게 전달', size: 10.5, fill: t.muted, anchor: 'start' });
  const payload = [
    ['답변 작성 의무 4가지', '출처 인용 · 추측 금지 · 플래그 보존 · 저장 제안'],
    ['모드별 4지선다 명령', 'work-intent면 답변 시작, 아니면 답변 끝'],
    ['현재 프로젝트 index.md', '최대 3KB'],
    ['같은 그룹 타 프로젝트 index', '각 1.5KB — cross-project 가시화'],
    ['매칭 top 5 페이지 excerpt', '머리 15줄 + 매칭 라인 ±5줄, 각 2.5KB'],
  ];
  payload.forEach(([a, b], i) => {
    const y = 250 + i * 32;
    g += `<circle cx="${528}" cy="${y}" r="3" fill="${t.blue}"/>`;
    g += txt({ x: 542, y: y + 4, s: a, size: 11.5, fill: t.text, weight: 600, anchor: 'start' });
    g += txt({ x: 542, y: y + 19, s: b, size: 10.5, fill: t.muted, anchor: 'start' });
  });
  g += arrow({ x1: 448, y1: 294, x2: 498, y2: 294, c: t.blue, dir: 'right' });
  g += txt({ x: 473, y: 286, s: '주입', size: 10, fill: t.muted });

  g += arrow({ x1: 688, y1: 412, x2: 688, y2: 444, c: t.line });
  g += node({ x: 500, y: 444, w: 376, h: 46, fill: t.orangeBg, stroke: t.orangeBorder, title: 'Main Claude', titleSize: 13, titleFill: t.orange });

  return { W, H, g };
};

/* 3. 모드 분기 */
D['mode-branch'] = (t) => {
  const W = 900, H = 570;
  let g = '';
  const cx = 450;

  g += node({ x: 320, y: 20, w: 260, h: 46, fill: t.surface, stroke: t.border, title: 'hook이 넘긴 signals', titleSize: 13, titleFill: t.text });
  g += arrow({ x1: cx, y1: 66, x2: cx, y2: 96, c: t.line });

  const decision = (y, label) => rect({ x: 300, y, w: 300, h: 50, fill: t.amberBg, stroke: t.amberBorder, r: 25 })
    + txt({ x: cx, y: y + 31, s: label, size: 13, fill: t.amber, weight: 600, mono: true });

  g += decision(96, 'precedent-likely = true ?');
  g += decision(196, 'work-intent = true ?');
  g += arrow({ x1: cx, y1: 146, x2: cx, y2: 196, c: t.line });
  g += txt({ x: 466, y: 176, s: 'yes', size: 11, fill: t.muted, anchor: 'start' });

  g += elbow({ pts: [[300, 121], [160, 121], [160, 292]], c: t.line, dir: 'down' });
  g += txt({ x: 234, y: 112, s: 'no', size: 11, fill: t.muted });

  g += arrow({ x1: cx, y1: 246, x2: cx, y2: 292, c: t.line });
  g += txt({ x: 466, y: 274, s: 'no', size: 11, fill: t.muted, anchor: 'start' });

  g += elbow({ pts: [[600, 221], [740, 221], [740, 292]], c: t.line, dir: 'down' });
  g += txt({ x: 668, y: 212, s: 'yes', size: 11, fill: t.muted });

  const card = (x, fill, stroke, accent, title, tag, rows) => {
    let s = rect({ x, y: 292, w: 272, h: 152, fill, stroke });
    s += txt({ x: x + 136, y: 322, s: title, size: 15, fill: accent, weight: 700 });
    s += txt({ x: x + 136, y: 342, s: tag, size: 10.5, fill: t.muted });
    s += lines({ x: x + 136, y: 368, gap: 20, items: rows.map((r) => ({ s: r, fill: t.text, size: 11.5 })) });
    return s;
  };
  g += card(24, t.card, t.border, t.text, '일반 답변', '판례 없음', ['4지선다 없음', '평소대로 답변', 'wiki 있으면 인용만']);
  g += card(314, t.blueBg, t.blueBorder, t.blue, '질문 모드', '“어떻게 구현됐어?”', ['답변 본문 먼저', '4지선다를 답변 끝에', '코드 수정 없음']);
  g += card(604, t.orangeBg, t.orangeBorder, t.orange, '작업 모드', '“이렇게 만들어줘”', ['4지선다를 답변 시작에', 'Edit / Write 호출 금지', '사용자 응답 후 착수']);

  g += arrow({ x1: 450, y1: 444, x2: 450, y2: 466, c: t.line, dash: '4 4' });
  g += arrow({ x1: 740, y1: 444, x2: 740, y2: 466, c: t.line, dash: '4 4' });

  g += rect({ x: 24, y: 466, w: 852, h: 80, fill: t.surface, stroke: t.border });
  g += txt({ x: 44, y: 492, s: '4지선다 — 코드가 바뀌기 전에 사용자가 고른다', size: 12.5, fill: t.text, weight: 700, anchor: 'start' });
  const opts = [['(A)', '똑같이 반영'], ['(B)', '부분 반영'], ['(C)', '새로 판단'], ['(D)', '참고만']];
  opts.forEach(([k, v], i) => {
    const x = 48 + i * 208;
    g += txt({ x, y: 522, s: k, size: 12, fill: t.purple, weight: 700, anchor: 'start', mono: true });
    g += txt({ x: x + 34, y: 522, s: v, size: 12, fill: t.text, anchor: 'start' });
  });

  return { W, H, g };
};

/* 4. 설치 레이아웃 */
D['layout'] = (t) => {
  const W = 900, H = 434;
  let g = '';

  const panel = (x, w, title, sub, rows, accent) => {
    let s = rect({ x, y: 40, w, h: 370, fill: t.surface, stroke: t.border });
    s += txt({ x: x + 18, y: 68, s: title, size: 13, fill: accent, weight: 700, anchor: 'start', mono: true });
    s += txt({ x: x + 18, y: 86, s: sub, size: 10.5, fill: t.muted, anchor: 'start' });
    s += `<line x1="${x + 18}" y1="98" x2="${x + w - 18}" y2="98" stroke="${t.border}" stroke-width="1"/>`;
    let y = 122;
    rows.forEach((r) => {
      if (r.gap) { y += 8; return; }
      s += txt({ x: x + 18, y, s: r.k, size: 11.5, fill: t.text, weight: r.b ? 600 : 400, anchor: 'start', mono: r.m });
      if (r.d) { s += txt({ x: x + 18, y: y + 15, s: r.d, size: 10, fill: t.muted, anchor: 'start' }); y += 15; }
      y += 22;
    });
    return s;
  };

  g += panel(20, 240, 'npm 패키지', '이 레포', [
    { k: 'skills/  ×7', b: true, m: true },
    { k: 'wiki · wiki-config · wiki-lint', d: 'wiki-resolve · validate · clarify · commit' },
    { gap: 1 },
    { k: 'scripts/hooks/  ×3', b: true, m: true },
    { k: 'wiki-auto-consult.py', m: true },
    { k: 'wiki-cite-verify.py', m: true },
    { k: 'wiki-build-index.py', m: true },
    { gap: 1 },
    { k: 'scripts/install.js', b: true, m: true },
    { k: 'postinstall로 자동 실행' },
  ], t.purple);

  g += panel(316, 268, '~/.claude/', 'Claude Code 설정 — 심링크로 연결', [
    { k: 'settings.json', b: true, m: true },
    { k: 'env 주입 + hook 2종 등록' },
    { gap: 1 },
    { k: 'CLAUDE.md', b: true, m: true },
    { k: 'auto-consult 정책 블록 (마커 사이)' },
    { gap: 1 },
    { k: 'hooks/wiki4-auto-consult.py', b: true, m: true },
    { k: 'hooks/wiki4-cite-verify.py', b: true, m: true },
    { k: '→ 레포 파일로 향하는 심링크' },
    { gap: 1 },
    { k: 'skills/wiki*  ×7', b: true, m: true },
    { k: '→ 레포 폴더로 향하는 심링크' },
  ], t.blue);

  g += panel(640, 240, '$WIKI_PATH/', '위키 데이터 — 제거해도 남는다', [
    { k: '<Group>/<Project>/wiki/', b: true, m: true },
    { gap: 1 },
    { k: 'index.md', d: 'ToC, 자동 갱신', m: true },
    { k: 'log.md', d: '인제스트 히스토리', m: true },
    { k: 'concepts/<domain>/', d: '패턴 · 개념', m: true },
    { k: 'entities/<domain>/', d: '모듈 · 서비스', m: true },
    { k: 'decisions/', d: 'ADR', m: true },
    { k: 'actions/', d: 'resolve 적용 기록', m: true },
    { k: '.wiki4-index.json', d: 'inverted index', m: true },
  ], t.green);

  g += arrow({ x1: 262, y1: 236, x2: 314, y2: 236, c: t.line, dir: 'right' });
  g += lines({ x: 288, y: 218, gap: 12, items: [{ s: 'npm', fill: t.muted, size: 10 }, { s: 'postinstall', fill: t.muted, size: 10 }] });

  g += arrow({ x1: 586, y1: 236, x2: 638, y2: 236, c: t.line, dir: 'right', dash: '4 4' });
  g += lines({ x: 612, y: 218, gap: 12, items: [{ s: 'hook이', fill: t.muted, size: 10 }, { s: '읽음', fill: t.muted, size: 10 }] });

  return { W, H, g };
};

/* 5. 스킬 맵 + 인제스트 체인 */
D['skills'] = (t) => {
  const W = 900, H = 392;
  let g = '';

  g += txt({ x: 24, y: 28, s: '직접 호출 — 사용자 진입점', size: 12.5, fill: t.text, weight: 700, anchor: 'start' });
  const cards = [
    ['/wiki', '인제스트', '코드 · 문서 · 인사이트를', '위키 페이지로 영구 기록', true],
    ['/wiki-config', '설정', '그룹 · 프로젝트 매핑 ·', '검색 범위 10개 메뉴', false],
    ['/wiki-lint', '점검', '깨진 링크 · 고아 페이지 ·', 'schema 불일치 검출', false],
    ['/wiki-resolve', '적용', '판례를 실코드에 dry-run 후', 'atomic 적용 (5단계)', false],
  ];
  cards.forEach(([name, tag, l1, l2, primary], i) => {
    const x = 24 + i * 216;
    g += rect({ x, y: 42, w: 204, h: 100, fill: primary ? t.blueBg : t.card, stroke: primary ? t.blueBorder : t.border });
    g += txt({ x: x + 102, y: 68, s: name, size: 13.5, fill: primary ? t.blue : t.text, weight: 700, mono: true });
    g += txt({ x: x + 102, y: 86, s: tag, size: 10, fill: t.muted });
    g += lines({ x: x + 102, y: 108, gap: 16, items: [{ s: l1, fill: t.text, size: 10.5 }, { s: l2, fill: t.text, size: 10.5 }] });
  });

  g += txt({ x: 24, y: 180, s: '/wiki 인제스트 체인 — 나머지 스킬 3개가 자동으로 물린다', size: 12.5, fill: t.text, weight: 700, anchor: 'start' });
  g += rect({ x: 24, y: 194, w: 852, h: 174, fill: t.surface, stroke: t.border });

  const chain = [
    ['입력 분석', 'kind · domain', 'slug 결정', false],
    ['/wiki-clarify', '모호점 3문항', '→ clarifications/', true],
    ['페이지 작성', 'frontmatter', '+ 본문', false],
    ['/wiki-validate', 'schema · 링크', '중복 게이트', true],
    ['/wiki-commit', 'git 자동 커밋', '+ index · log 갱신', true],
  ];
  chain.forEach(([a, b, c, internal], i) => {
    const x = 40 + i * 168;
    g += rect({ x, y: 224, w: 146, h: 84, fill: internal ? t.purpleBg : t.card, stroke: internal ? t.purpleBorder : t.border, r: 9 });
    g += txt({ x: x + 73, y: 250, s: a, size: 12, fill: internal ? t.purple : t.text, weight: 700, mono: internal });
    g += lines({ x: x + 73, y: 270, gap: 15, items: [{ s: b, fill: t.muted, size: 10 }, { s: c, fill: t.muted, size: 10 }] });
    if (i < chain.length - 1) g += arrow({ x1: x + 146, y1: 266, x2: x + 168, y2: 266, c: t.line, dir: 'right' });
  });

  g += txt({ x: 450, y: 338, s: '/wiki-validate 게이트를 통과하지 못하면 페이지는 저장되지 않는다 — 사용자 승인 없는 자동 쓰기 없음', size: 10.5, fill: t.muted });

  return { W, H, g };
};

/* ---------- render ---------- */

mkdirSync(OUT, { recursive: true });
let n = 0;
for (const [name, build] of Object.entries(D)) {
  for (const [theme, t] of Object.entries(THEMES)) {
    const { W, H, g } = build(t);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`
      + `<rect width="${W}" height="${H}" fill="${t.bg}"/>${g}</svg>\n`;
    writeFileSync(join(OUT, `${name}-${theme}.svg`), svg);
    n++;
  }
}
console.log(`generated ${n} svg → docs/assets/`);
