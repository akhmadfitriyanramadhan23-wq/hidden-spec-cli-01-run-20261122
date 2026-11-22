// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies the edits AI models write,
// in four formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), to a tree of text files.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit: it applies itself to the tree, throwing Fail when it cannot. `move` names a move it made. */
type Edit = ((tree: Tree) => void) & { move?: [string, string] };

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fileText(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

// ---- Section 5: matching lines at three tiers ----

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEndWs(line);
  return trimWs(line);
}

/** Every 0-based position where O occurs in lines at this tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const keys = o.map((l) => tierKey(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions; null when it occurs at no tier. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one; an end-of-file search takes
 * only an occurrence that ends at the file's last line. */
function findTierFrom(lines: string[], o: string[], from: number, eof: boolean, strict: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from && (!eof || p + o.length === lines.length));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const key = tierKey(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (tierKey(lines[i]!, t) === key) return i;
    }
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line, `ctx` its index in O) or a new line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** The lines N becomes when O matched at `pos`: context lines are the file's own lines, other lines are
 * re-indented at tier 2 (section 5) and written as they are at tiers 0 and 1. */
function buildReplacement(lines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && o.length > 0) {
    const f = leadWs(lines[pos]!);
    const p = leadWs(o[0]!);
    for (const e of n) {
      if (e.ctx !== null) {
        out.push(lines[pos + e.ctx]!);
        continue;
      }
      const t = e.text;
      if (t === '' || t.trim() === '') {
        out.push(t);
        continue;
      }
      out.push(t.startsWith(p) ? f + t.slice(p.length) : t);
    }
    return out;
  }
  for (const e of n) out.push(e.ctx !== null ? lines[pos + e.ctx]! : e.text);
  return out;
}

/** A hunk or chunk body, split into its old lines O (context and `-` lines) and its new lines N
 * (context and `+` lines, context lines tagged with their index in O). `\` lines are ignored here. */
function splitBody(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const line of body) {
    if (line === '' || line[0] === ' ') {
      const text = line === '' ? '' : line.slice(1);
      n.push({ text, ctx: o.length });
      o.push(text);
    } else if (line[0] === '-') {
      o.push(line.slice(1));
    } else if (line[0] === '+') {
      n.push({ text: line.slice(1), ctx: null });
    }
  }
  return { o, n };
}

// ---- Section 4: detecting the format ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 9: JSON edits ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  noEol: boolean;
  plusNoEol: boolean;
  hasPlus: boolean;
}

function makeHunk(a: number, body: string[]): Hunk {
  const { o, n } = splitBody(body);
  let lastCtxAdd = -1;
  let lastPlus = -1;
  let hasPlus = false;
  for (let j = 0; j < body.length; j++) {
    const line = body[j]!;
    if (line === '' || line[0] === ' ' || line[0] === '+') lastCtxAdd = j;
    if (line[0] === '+') {
      lastPlus = j;
      hasPlus = true;
    }
  }
  const noEol = lastCtxAdd >= 0 && body[lastCtxAdd + 1] !== undefined && body[lastCtxAdd + 1]![0] === '\\';
  const plusNoEol = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\';
  return { a, o, n, noEol, plusNoEol, hasPlus };
}

/** The path a `--- ` or `+++ ` line names: text after the four characters, up to the first tab,
 * with surrounding spaces removed; `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function diffPath(text: string): string | null {
  const t = text.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: Hunk[];
}

interface UniBuilder {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  inHeader: boolean;
}

function finishUni(b: UniBuilder): UniSection {
  const oldPath: string | null = b.dashOld !== undefined ? b.dashOld : (b.renameFrom ?? b.diffOld ?? null);
  const newPath: string | null = b.dashNew !== undefined ? b.dashNew : (b.renameTo ?? b.diffNew ?? null);
  let kind: UniSection['kind'];
  if (oldPath === null || b.newFile) kind = 'create';
  else if (newPath === null || b.deletedFile) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  return { oldPath, newPath, kind, hunks: b.hunks };
}

/** Apply a section's hunks in order to the file's lines, each to the result of the ones before it. */
function applyHunks(parts: FileParts, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > parts.lines.length) pos = parts.lines.length;
      const atEnd = pos === parts.lines.length;
      const nLines = h.n.map((e) => e.text);
      parts.lines.splice(pos, 0, ...nLines);
      if (atEnd) parts.final = !h.noEol;
      d += nLines.length;
      continue;
    }
    const found = findTier(parts.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const toEnd = best + h.o.length === parts.lines.length;
    const nLines = buildReplacement(parts.lines, best, h.o, h.n, found.tier);
    parts.lines.splice(best, h.o.length, ...nLines);
    if (toEnd) parts.final = !h.noEol;
    d += h.n.length - h.o.length;
  }
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const edit = ((tree: Tree): void => {
    if (sec.kind === 'create') {
      const p = sec.newPath ?? '';
      if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const e of h.n) if (e.ctx === null) plus.push(e.text);
      let finalBreak = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.hasPlus) {
          finalBreak = !h.plusNoEol;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (sec.kind === 'delete') {
      const p = sec.oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.kind === 'move') {
      const oldP = sec.oldPath!;
      const newP = sec.newPath!;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const parts = fileParts(before);
      applyHunks(parts, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, fileText(parts));
      return;
    }
    const p = sec.oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const parts = fileParts(before);
    applyHunks(parts, sec.hunks, strict, p);
    tree.now.set(p, fileText(parts));
  }) as Edit;
  if (sec.kind === 'move') edit.move = [sec.oldPath!, sec.newPath!];
  return edit;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniBuilder | null = null;
  const fresh = (): UniBuilder => ({
    diffOld: null,
    diffNew: null,
    dashOld: undefined,
    dashNew: undefined,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
    inHeader: true,
  });
  const finish = (): void => {
    if (cur !== null) sections.push(finishUni(cur));
    cur = null;
  };
  const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.inHeader && cur.dashOld === undefined) {
        cur.dashOld = diffPath(line.slice(4));
        cur.dashNew = diffPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      finish();
      cur = fresh();
      cur.dashOld = diffPath(line.slice(4));
      cur.dashNew = diffPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (isDiffGit(bl)) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(makeHunk(Number(m[1]), body));
      i = j;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.dashNew = diffPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  finish();
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = fileParts(before);
    const found = findTier(parts.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nLines = buildReplacement(
      parts.lines,
      pos,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: null })),
      found.tier,
    );
    parts.lines.splice(pos, oldLines.length, ...nLines);
    tree.now.set(path, fileText(parts));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  const edit = ((tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = fileParts(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(parts.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? parts.lines.length : cursor;
        const nLines = n.map((e) => e.text);
        parts.lines.splice(pos, 0, ...nLines);
        cursor = pos + nLines.length;
      } else {
        const found = findTierFrom(parts.lines, o, cursor, ch.eof, strict);
        if (found === null) throw new Fail('no-match', path);
        const nLines = buildReplacement(parts.lines, found.pos, o, n, found.tier);
        parts.lines.splice(found.pos, o.length, ...nLines);
        cursor = found.pos + nLines.length;
      }
    }
    const out = fileText(parts);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
    } else {
      tree.now.set(path, out);
    }
  }) as Edit;
  if (moveTo !== null) edit.move = [path, moveTo];
  return edit;
}

interface SecLine {
  text: string;
  num: number;
}

function buildV4aSection(kind: 'add' | 'delete' | 'update', path: string, secLines: SecLine[], updateLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const out: string[] = [];
    for (const { text, num } of secLines) {
      if (text.startsWith('+')) out.push(text.slice(1));
      else if (blank(text)) out.push('');
      else throw new Exit2(`error: parse ${num}`);
    }
    return v4aAddEdit(path, out);
  }
  if (kind === 'delete') {
    if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.num}`);
    return v4aDeleteEdit(path);
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let current: VChunk | null = null;
  const pushCurrent = (): void => {
    if (current !== null) {
      chunks.push(current);
      current = null;
    }
  };
  for (let k = idx; k < secLines.length; k++) {
    const { text, num } = secLines[k]!;
    if (text.startsWith('@@')) {
      pushCurrent();
      const anchor = text.slice(2).trim();
      current = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      continue;
    }
    if (text.trim() === '*** End of File') {
      if (current === null) throw new Exit2(`error: parse ${num}`);
      current.eof = true;
      pushCurrent();
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (current === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${num}`);
        current = { anchor: null, eof: false, body: [] };
      }
      current.body.push(text);
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  pushCurrent();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return v4aUpdateEdit(path, moveTo, chunks, strict);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind: 'add' | 'delete' | 'update' = line.startsWith('*** Add File: ')
      ? 'add'
      : line.startsWith('*** Delete File: ')
        ? 'delete'
        : 'update';
    const path = line.slice(kind === 'add' ? 14 : 17).trim();
    const secLines: SecLine[] = [];
    let j = i + 1;
    while (j < last) {
      if (isSectionStart(lines[j]!)) break;
      secLines.push({ text: lines[j]!, num: j + 1 });
      j += 1;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    edits.push(buildV4aSection(kind, path, secLines, i + 1, strict));
    i = j;
  }
  return edits;
}

// ---- Sections 1, 2 and 10: invocation, output and exit codes, order and atomicity ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
      if (edit.move !== undefined) moves.push(edit.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      for (let r = rows.length - 1; r >= 0; r--) {
        if (rows[r]!.key === oldP || rows[r]!.key === newP) rows.splice(r, 1);
      }
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
