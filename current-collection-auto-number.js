/**
 * Zotero Actions & Tags：当前分类自动编号
 * 事件：无；操作：customScript；快捷键：Command+B
 * 只处理当前选中分类直接收录的一篇文献。
 */

// Actions & Tags 会先以 items 调用一次，再逐条以 item 调用；避免重复执行。
if (item) return;

const Z = require("Zotero");
const tell = message =>
  Z.alert(Z.getMainWindow(), "当前分类自动编号", message);

if (!Array.isArray(items) || items.length !== 1) {
  tell("请在一个具体分类中只选择一篇论文。");
  return;
}

const paper = items[0];

if (!paper.isRegularItem()) {
  tell("请选择论文条目，不要选择附件或笔记。");
  return;
}

const pane = Z.getActiveZoteroPane();

if (!pane?.collectionsView ||
    pane.collectionsView.selection.count !== 1) {
  tell("请先在左侧只选中一个具体分类。");
  return;
}

const folders = pane.getSelectedCollections();

if (folders.length !== 1) {
  tell("当前视图不是单个具体分类，请手动编号。");
  return;
}

const folder = folders[0];

if (!paper.inCollection(folder.id)) {
  tell("这篇论文并未直接加入当前分类；请切到它实际所在的分类后再试。");
  return;
}

// 当前库的“标题翻译”存放在 Extra 的 titleTranslation 行。
function translationOf(x) {
  const extra = String(x.getField("extra") || "");
  const newline = extra.includes("\r\n") ? "\r\n" : "\n";
  const lines = extra.split(/\r?\n/);
  const hits = [];

  lines.forEach((line, index) => {
    const m = line.match(/^(\s*titleTranslation\s*:\s*)(.*)$/i);
    if (m) {
      hits.push({ index, head: m[1], value: m[2] });
    }
  });

  return { extra, newline, lines, hits };
}

// 识别 A20、B01、SF03；纯数字后接译文时须有分隔符。
function codeAtStart(value) {
  const s = String(value || "").trim();

  let m = s.match(/^([A-Za-z]{1,4})(\d+)(?=$|[^A-Za-z0-9])/);
  if (m) {
    const n = Number(m[2]);
    return Number.isSafeInteger(n)
      ? { prefix: m[1].toUpperCase(), number: n, width: m[2].length }
      : null;
  }

  // 不把“2026年……”之类的译名当作纯数字编号。
  m = s.match(/^(\d+)(?=$|[\s|｜:：._\-–—、\]\)])/);
  if (!m) return null;

  const n = Number(m[1]);
  return Number.isSafeInteger(n)
    ? { prefix: "", number: n, width: m[1].length }
    : null;
}

try {
  const own = translationOf(paper);

  if (own.hits.length > 1) {
    tell("这篇论文有多条 titleTranslation 记录，请手动检查。");
    return;
  }

  if (own.hits.length && codeAtStart(own.hits[0].value)) {
    tell("这篇论文已有开头编号，未作修改。");
    return;
  }

  const groups = new Map();

  // getChildItems 仅取当前分类直接收录的条目，不含子分类。
  for (const other of folder.getChildItems(false, false)) {
    if (other.id === paper.id || !other.isRegularItem()) continue;

    const info = translationOf(other);

    if (info.hits.length > 1) {
      tell("当前分类有条目包含多条 titleTranslation，无法可靠判断，请手动编号。");
      return;
    }

    if (info.hits.length !== 1) continue;

    const c = codeAtStart(info.hits[0].value);
    if (!c) continue;

    let g = groups.get(c.prefix);
    if (!g) {
      g = {
        count: 0,
        max: -1,
        width: 0,
        seen: new Set(),
        duplicate: false
      };
      groups.set(c.prefix, g);
    }

    g.count++;
    g.max = Math.max(g.max, c.number);
    g.width = Math.max(g.width, c.width);
    if (g.seen.has(c.number)) g.duplicate = true;
    g.seen.add(c.number);
  }

  const ranked = [...groups].sort((a, b) => b[1].count - a[1].count);
  const total = ranked.reduce((sum, [, g]) => sum + g.count, 0);

  if (!total) {
    tell("当前分类没有可识别的已有编号，请手动编号。");
    return;
  }

  const [prefix, group] = ranked[0];

  // 只接受严格多数；胜出组有重号时也停止。
  if (group.count * 2 <= total ||
      group.duplicate ||
      !Number.isSafeInteger(group.max + 1)) {
    const detail = ranked
      .map(([p, g]) => (p || "纯数字") + "：" + g.count)
      .join("，");

    tell("当前分类的编号规则不够确定（" + detail + "），请手动编号。");
    return;
  }

  const newCode =
    prefix + String(group.max + 1).padStart(group.width, "0");

  let newExtra;

  if (own.hits.length) {
    const h = own.hits[0];
    const oldText = h.value.trim();

    own.lines[h.index] =
      h.head + newCode + (oldText ? "｜" + oldText : "");

    newExtra = own.lines.join(own.newline);
  } else {
    newExtra =
      own.extra +
      (own.extra && !/[\r\n]$/.test(own.extra)
        ? own.newline
        : "") +
      "titleTranslation: " + newCode;
  }

  paper.setField("extra", newExtra);
  await paper.saveTx();

  tell("已在「" + folder.name + "」中编号为 " + newCode + "。");
} catch (error) {
  Z.logError(error);
  tell("编号失败，未能完成保存：" + (error.message || error));
}
