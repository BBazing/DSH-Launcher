/**
 * cordis.mjs — DSH 插件树与补丁层的解析 / 安全改写
 *
 * 设计原则：cordis.patch.yml 里允许出现 `!!js` 表达式，任何"完整 YAML 反序列化
 * 再序列化"的做法都会破坏用户配置。因此这里全部采用**逐行结构编辑**：
 * 只增删改目标条目的 `disabled:` 行，其余字节原样保留。
 */

/** 把补丁文件切成 [前言行...] 和 [条目行数组...]，可无损拼回。 */
export function splitPatch(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const preamble = [];
  const entries = [];
  let cur = null;
  for (const ln of lines) {
    if (/^- /.test(ln)) {
      cur = [ln];
      entries.push(cur);
    } else if (cur) {
      cur.push(ln);
    } else {
      preamble.push(ln);
    }
  }
  return { preamble, entries, eol: String(text).includes('\r\n') ? '\r\n' : '\n' };
}

export function joinPatch({ preamble, entries, eol = '\n' }) {
  const parts = [];
  if (preamble.length) parts.push(preamble.join('\n'));
  for (const e of entries) parts.push(e.join('\n'));
  return parts.join('\n').replaceAll('\n', eol);
}

const unquote = (s) => String(s ?? '').trim().replace(/^['"]|['"]$/g, '');

/** 读取一个条目块的结构化字段。 */
export function readEntry(blockLines) {
  const head = blockLines[0] ?? '';
  const m = head.match(/^-\s*id:\s*(.*)$/);
  let id = m ? unquote(m[1]) : null;
  let name = null;
  let disabled = null;
  for (let i = 0; i < blockLines.length; i++) {
    const ln = blockLines[i];
    const n = ln.match(/^  name:\s*(.*)$/);
    if (n && name === null) name = unquote(n[1]);
    const d = ln.match(/^  disabled:\s*(.*)$/);
    if (d && disabled === null) disabled = d[1].trim();
  }
  return { id, name, disabled };
}

/** 把 YAML 的 disabled 取值归一化成 true / false / 'conditional'。 */
function disabledState(raw) {
  if (raw === null || raw === undefined || raw === '') return false;
  const v = String(raw).trim();
  if (v === 'true' || v === 'yes') return true;
  if (v === 'false' || v === 'no') return false;
  return 'conditional'; // 例如 !!js 表达式
}

/** 解析 cordis.yml / cordis.patch.yml 的顶层条目列表。 */
export function parseTree(text) {
  const { entries } = splitPatch(text);
  return entries.map((block, index) => {
    const { id, name, disabled } = readEntry(block);
    return {
      index,
      id,
      name,
      disabled: disabledState(disabled),
      disabledRaw: disabled,
      hasConfig: block.some((l) => /^  config:/.test(l)),
    };
  });
}

/** 在条目列表里定位目标：优先按 id 匹配，其次按包名匹配。 */
function findEntryIndex(entries, { id, name }) {
  if (id) {
    const i = entries.findIndex((b) => readEntry(b).id === id);
    return i;
  }
  if (name) {
    const i = entries.findIndex((b) => readEntry(b).name === name);
    if (i >= 0) return i;
  }
  return -1;
}

/** 在条目块内写入/覆盖/移除 disabled 行。 */
function writeDisabled(blockLines, value) {
  const idx = blockLines.findIndex((l) => /^  disabled:/.test(l));
  if (idx >= 0) {
    blockLines[idx] = `  disabled: ${value}`;
    return blockLines;
  }
  // 没有 disabled 行：插到 name 行之后（保持可读性），否则插到头部之后
  let at = blockLines.findIndex((l) => /^  name:/.test(l));
  if (at < 0) at = 0;
  blockLines.splice(at + 1, 0, `  disabled: ${value}`);
  return blockLines;
}

/** 条目块除 id / name 之外是否还有实质内容（config、注释等）。 */
function entryHasContent(blockLines) {
  return blockLines.slice(1).some((l) => l.trim() && !/^  name:/.test(l));
}

function removeDisabledLine(blockLines) {
  const idx = blockLines.findIndex((l) => /^  disabled:/.test(l));
  if (idx < 0) return false;
  blockLines.splice(idx, 1);
  return true;
}

/**
 * 开关一个插件。
 *
 * 语义要点：当目标状态与 base 层默认值一致时，会把补丁里的 disabled 覆盖**撤掉**
 * 而不是写 `disabled: false`，这样"关掉再打开"能字节级回到原文件。
 * baseDisabled 由调用方从 cordis.yml 读取后传入。
 *
 * @param {string} text          当前 cordis.patch.yml 内容
 * @param {{id?:string,name?:string}} target
 * @param {boolean} disabled     目标状态：true = 禁用
 * @param {{baseDisabled?:boolean|'conditional'}} [opts]
 */
export function setPluginDisabled(text, { id, name }, disabled, opts = {}) {
  const doc = splitPatch(text);
  const value = disabled ? 'true' : 'false';
  const base = opts.baseDisabled;
  const baseKnown = base === true || base === false;
  // 目标状态已经等于 base 默认 -> 补丁层不需要这条覆盖
  const redundant = baseKnown && base === disabled;
  const idx = findEntryIndex(doc.entries, { id, name });

  if (idx >= 0) {
    const block = doc.entries[idx];
    const before = readEntry(block);
    const beforeState = disabledState(before.disabled);

    if (redundant) {
      const had = removeDisabledLine(block);
      if (!had) return { text, action: 'noop', before: beforeState, after: base, entryId: before.id, entryName: before.name };
      if (!entryHasContent(block)) {
        doc.entries.splice(idx, 1);
        return { text: joinPatch(doc), action: 'removed', before: beforeState, after: base, entryId: before.id, entryName: before.name };
      }
      return { text: joinPatch(doc), action: 'cleared', before: beforeState, after: base, entryId: before.id, entryName: before.name };
    }

    writeDisabled(block, value);
    const after = readEntry(block);
    return {
      text: joinPatch(doc), action: 'updated',
      before: beforeState, after: disabledState(after.disabled),
      entryId: after.id, entryName: after.name,
    };
  }

  // 无补丁条目：目标状态若已由 base 层达成则无需写入
  if (!disabled && base !== true) {
    return { text, action: 'noop', before: base ?? false, after: base ?? false, entryId: id, entryName: name };
  }

  // 追加新条目（禁用 base 启用项，或显式启用 base 禁用项）
  const title = name || id || 'plugin';
  if (!doc.preamble.some((l) => l.trim().startsWith('#'))) {
    doc.preamble = ['# dsh-launcher patch layer'];
  }
  const last = doc.entries[doc.entries.length - 1];
  if (last && last[last.length - 1] !== '') last.push('');
  const block = [`- id: ${id || title}`];
  if (name) block.push(`  name: "${name}"`);
  block.push(`  disabled: ${value}`, '');
  doc.entries.push(block);

  return {
    text: joinPatch(doc), action: 'appended',
    before: base ?? false, after: disabled, entryId: id, entryName: name,
  };
}

/** 删除某个补丁条目（用于"恢复默认"）。 */
export function removePluginEntry(text, { id, name }) {
  const doc = splitPatch(text);
  const idx = findEntryIndex(doc.entries, { id, name });
  if (idx < 0) return { text, action: 'noop' };
  const removed = readEntry(doc.entries[idx]);
  doc.entries.splice(idx, 1);
  return { text: joinPatch(doc), action: 'removed', entryId: removed.id, entryName: removed.name };
}

/** 只撤销开关覆盖，保留用户的 config、注释和其它字段。 */
export function resetPluginDisabled(text, target) {
  const doc = splitPatch(text);
  const idx = findEntryIndex(doc.entries, target);
  if (idx < 0 || !removeDisabledLine(doc.entries[idx])) return { text, action: 'noop' };
  if (!entryHasContent(doc.entries[idx])) doc.entries.splice(idx, 1);
  return { text: joinPatch(doc), action: 'reset' };
}
