import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, ask, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  url,
  Item,
  Meta,
  OpenResult,
  DirInfo,
  LABELS,
  LABEL_PRESETS,
  LabelKey,
  LabelNames,
  labelColor,
  labelKey,
  labelName,
  getLabelNames,
  setLabelNames,
  stars,
  fmtBytes,
  FileInfo,
} from "./api";
import { Grid } from "./grid";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { BatchRename } from "./rename";
import { Exporter } from "./exporter";
import { Editor } from "./editor";
import { TextEditor } from "./textedit";
import { FolderTree } from "./foldertree";
import { setImg, clearImg, prefetchImg, onImageDiag } from "./imgload";
import { Cull, Analysis, drawFaces, contentRect } from "./cull";
import {
  Slideshow,
  SlideSettings,
  DEFAULT_SETTINGS,
  fileName,
  fmtTime,
  audioDuration,
  audioSrc,
  audioErrors,
  mediaErrorText,
} from "./slideshow";

// ---------------------------------------------------------------- state

type FilterKey = "suggest" | "eyes" | "sharp" | "rating" | "label" | "edited" | "kind" | "camera" | "lens";

const cull = new Cull();

const S = {
  session: 0,
  dir: "",
  parent: null as string | null,
  items: [] as Item[],
  /** 目前資料夾裡的子資料夾（顯示在縮圖區最前面） */
  subdirs: [] as DirInfo[],
  /** 縮圖區選取的資料夾（"" = 沒有）；選了資料夾時評等 / 標籤鍵作用在資料夾上 */
  folderSel: "",
  meta: new Map<number, Meta>(),
  overrides: new Map<number, Partial<Meta>>(), // 中繼資料還沒讀到前，使用者就先評分的值
  view: [] as Item[],
  viewIndex: new Map<number, number>(),
  selected: new Set<number>(),
  focus: null as number | null,
  anchor: null as number | null,
  filters: {
    rating: new Set<string>(),
    label: new Set<string>(),
    kind: new Set<string>(),
    camera: new Set<string>(),
    lens: new Set<string>(),
    sharp: new Set<string>(),
    suggest: new Set<string>(),
    eyes: new Set<string>(),
    edited: new Set<string>(),
  } as Record<FilterKey, Set<string>>,
  /** 已刪除（移到垃圾桶）的項目：留在陣列裡維持 id = 索引，但不再顯示 */
  removed: new Set<number>(),
  sort: "name",
  sortDesc: false,
  metaLoaded: 0,
  loupe: false,
  zoom: false,
  compare: [] as number[],
  compareActive: 0,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const gridEl = $("grid");
const grid = new Grid(gridEl, $("grid-spacer"), {
  session: () => S.session,
  view: () => S.view,
  meta: (id) => S.meta.get(id),
  isSelected: (id) => S.selected.has(id),
  focusId: () => (S.folderSel ? null : S.focus),
  badges: (id) => cull.badges(id),
  onCellClick,
  onCellMenu: (i, ev) => showCellMenu(i, ev),
  onCellDrag,
  onCellUp,
  onCellOpen: (i) => {
    setFocus(S.view[i].id, false);
    // 文字檔：按兩下直接用內建編輯器開啟
    if (S.view[i].kind === "text") return void textEditor.openEdit(S.session, S.view[i].id);
    openLoupe();
  },
  // 調整視窗開著時由它管理（縮圖列的照片不一定在主畫面上，不能被當成捲出畫面而取消）
  onViewport: debounce((ids: number[]) => {
    if (editor.isOpen) return;
    api.setViewport(S.session, ids).catch(() => {});
  }, 30),
  onFolderOpen: (path) => void openFolder(path),
  onFolderMenu: (path, ev) => showFolderMenu(path, ev),
  onFolderDrag: (path, name, ev) => startFolderDrag(path, name, ev),
  onFolderSelect: (path) => {
    S.folderSel = path;
    if (path) S.selected = new Set();
    grid.refresh();
    renderStatus();
  },
  onOrder: debounce((ids: number[]) => {
    api.setOrder(S.session, ids).catch(() => {});
  }, 200),
});

// ---------------------------------------------------------------- helpers

/** 事件監聽是非同步註冊的；開啟資料夾前要等全部註冊完，否則小資料夾的事件會在註冊前就送完而漏接 */
const listeners: Promise<unknown>[] = [];
function on<T>(event: string, cb: (e: { payload: T }) => void) {
  listeners.push(listen<T>(event, cb));
}

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t = 0;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

let toastTimer = 0;
let toastRemaining = 0;
let toastStarted = 0;

function hideToastLater(ms: number) {
  clearTimeout(toastTimer);
  toastRemaining = ms;
  toastStarted = Date.now();
  toastTimer = window.setTimeout(() => $("toast").classList.add("hidden"), ms);
}

function toast(msg: string, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden", "has-action");
  hideToastLater(ms);
}

/** 可點選的提示訊息（例如「在 Finder 中開啟」）。滑鼠停在訊息上時暫停倒數 */
function notify(msg: string, action?: { label: string; run: () => void }, ms = toastSeconds() * 1000) {
  const t = $("toast");
  t.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-action";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      action.run();
      t.classList.add("hidden");
    });
    t.appendChild(b);
  }
  t.classList.toggle("has-action", !!action);
  t.classList.remove("hidden");
  hideToastLater(ms);
}

function toastSeconds(): number {
  const v = Number(storage("toastSeconds", 4));
  return Number.isFinite(v) && v >= 1 ? Math.min(60, v) : 4;
}

{
  const t = document.getElementById("toast")!;
  t.addEventListener("mouseenter", () => {
    clearTimeout(toastTimer);
    toastRemaining = Math.max(800, toastRemaining - (Date.now() - toastStarted));
  });
  t.addEventListener("mouseleave", () => {
    if (!t.classList.contains("hidden")) hideToastLater(toastRemaining);
  });
}

/** 「在 Finder 中開啟」這個資料夾 */
function openDirAction(dir: string) {
  const isMac = /Mac/.test(navigator.platform) || navigator.userAgent.includes("Mac OS X");
  return {
    label: isMac ? "在 Finder 中開啟" : "開啟資料夾",
    run: () => api.openDir(dir).catch((e) => toast(`無法開啟資料夾：${e}`)),
  };
}

function folderName(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function storage<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 無法寫入就算了 */
  }
}

function metaOf(id: number): Meta {
  let m = S.meta.get(id);
  if (!m) {
    m = { rating: 0, label: null };
    S.meta.set(id, m);
  }
  return m;
}


function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ---------------------------------------------------------------- filters & sorting

const RATING_ROWS: [string, string][] = [
  ["rej", "✕ 拒絕"],
  ["0", "無評等"],
  ["1", "★"],
  ["2", "★★"],
  ["3", "★★★"],
  ["4", "★★★★"],
  ["5", "★★★★★"],
];
const KIND_NAMES: Record<string, string> = {
  folder: "資料夾",
  "raw+jpeg": "RAW + JPEG",
  raw: "RAW",
  jpeg: "JPEG",
  image: "其他影像",
  other: "其他格式",
  text: "文字",
};

const LOADING = "\u0000loading";

/** 資料夾也能用「評等」「標籤」「檔案類型」篩選（仿 Bridge） */
const FOLDER_KEYS = new Set<FilterKey>(["rating", "label", "kind"]);
function folderFacet(key: FilterKey, d: DirInfo): string {
  if (key === "rating") {
    const r = d.rating ?? 0;
    return r < 0 ? "rej" : String(r);
  }
  if (key === "label") return d.label ? (labelKey(d.label) ?? "other") : "none";
  return "folder";
}

/** 依篩選條件要顯示的資料夾：有照片專屬的篩選（相機、調整…）時不顯示資料夾 */
function visibleFolders(): DirInfo[] {
  const active = FILTER_KEYS.filter((k) => S.filters[k].size);
  if (active.some((k) => !FOLDER_KEYS.has(k))) return [];
  return S.subdirs.filter((d) => active.every((k) => S.filters[k].has(folderFacet(k, d))));
}

function facet(key: FilterKey, it: Item): string {
  const m = S.meta.get(it.id);
  switch (key) {
    case "rating": {
      const r = m?.rating ?? 0;
      return r < 0 ? "rej" : String(r);
    }
    case "label":
      return m?.label ? (labelKey(m.label) ?? "other") : "none";
    case "edited":
      return m?.edited ? "yes" : "no";
    case "kind":
      return it.kind;
    // 還沒讀完 EXIF 的照片不算「未知」（讀完才知道有沒有），用 LOADING 表示，不出現在篩選選項裡
    case "camera":
      return m ? (m.camera ?? "未知") : LOADING;
    case "lens":
      return m ? (m.lens ?? "未知") : LOADING;
    case "suggest":
    case "eyes":
    case "sharp":
      return cull.facet(key, it.id);
  }
}

const FILTER_KEYS: FilterKey[] = ["suggest", "eyes", "sharp", "rating", "label", "edited", "kind", "camera", "lens"];

/** 尚未刪除的項目 */
function live(): Item[] {
  return S.removed.size ? S.items.filter((it) => !S.removed.has(it.id)) : S.items;
}

function passes(it: Item) {
  if (S.removed.has(it.id)) return false;
  for (const k of FILTER_KEYS) {
    const f = S.filters[k];
    if (f.size && !f.has(facet(k, it))) return false;
  }
  return true;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortValue(it: Item): number | string {
  const m = S.meta.get(it.id);
  switch (S.sort) {
    case "date":
      return m?.capture ?? new Date(it.mtime).toISOString().replace("T", " ");
    case "mtime":
      return it.mtime;
    case "added":
      return it.added ?? it.mtime;
    case "rating":
      return m?.rating ?? 0;
    case "size":
      return it.size;
    case "sharp":
      return cull.analysis.get(it.id)?.sharp ?? -1;
    default:
      return "";
  }
}

function recomputeView() {
  const oldIdx = S.focus !== null ? (S.viewIndex.get(S.focus) ?? 0) : 0;
  const v = S.items.filter(passes);
  if (S.sort === "name") {
    if (S.sortDesc) v.reverse();
  } else {
    const keyed = v.map((it) => [sortValue(it), it] as const);
    keyed.sort((a, b) => {
      const r =
        typeof a[0] === "number" ? (a[0] as number) - (b[0] as number) : collator.compare(a[0] as string, b[0] as string);
      return (S.sortDesc ? -r : r) || a[1].id - b[1].id;
    });
    v.splice(0, v.length, ...keyed.map((k) => k[1]));
  }
  S.view = v;
  S.viewIndex = new Map(v.map((it, i) => [it.id, i]));
  // 焦點被篩掉時，移到原本位置附近的那一張
  if (S.focus !== null && !S.viewIndex.has(S.focus)) {
    const n = v[Math.min(oldIdx, v.length - 1)];
    S.focus = n ? n.id : null;
    S.selected = new Set(n ? [n.id] : []);
  }
  for (const id of [...S.selected]) if (!S.viewIndex.has(id)) S.selected.delete(id);
}

function renderFilters() {
  const box = $("filters");
  const groups: [FilterKey, string, [string, string][]][] = [];
  const counts = (k: FilterKey) => {
    const c = new Map<string, number>();
    for (const it of live()) {
      const v = facet(k, it);
      c.set(v, (c.get(v) ?? 0) + 1);
    }
    if (FOLDER_KEYS.has(k))
      for (const d of S.subdirs) {
        const v = folderFacet(k, d);
        c.set(v, (c.get(v) ?? 0) + 1);
      }
    return c;
  };
  // 動態選項（相機、鏡頭）：有照片的值 + 已勾選的值（勾了就不會因為數量變 0 而消失、無法取消）
  const dyn = (k: FilterKey) =>
    [...new Set([...counts(k).keys(), ...S.filters[k]])].filter((v) => v !== LOADING).sort((a, b) => (a === "未知" ? 1 : b === "未知" ? -1 : collator.compare(a, b))).map((v) => [v, v] as [string, string]);

  if (cull.analysis.size) {
    groups.push(["suggest", "選片建議", [["cull", "建議淘汰"], ["keep", "沒有問題"], ["na", "尚未分析"]]]);
    if (cull.checksEyes)
      groups.push(["eyes", "眼睛", [["closed", "有人閉眼"], ["open", "沒有閉眼"], ["noface", "沒有人臉"], ["na", "尚未分析"]]]);
    groups.push(["sharp", "對焦", [["blur", "模糊 / 眼睛失焦"], ["ok", "清晰"], ["na", "尚未分析"]]]);
  }
  groups.push(["rating", "評等", RATING_ROWS]);
  groups.push([
    "label",
    "標籤",
    [
      ["none", "無標籤"],
      ...LABELS.map((l) => [l.key, `${l.zh} · ${labelName(l.key)}`] as [string, string]),
      ["other", "其他標籤名稱"],
    ],
  ]);
  groups.push(["edited", "調整", [["yes", "已調整"], ["no", "未調整"]]]);
  groups.push(["kind", "檔案類型", Object.entries(KIND_NAMES)]);
  groups.push(["camera", "相機", dyn("camera")]);
  groups.push(["lens", "鏡頭", dyn("lens")]);

  let html = "";
  const CHEV = `<svg class="fg-chev" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  /** 一組篩選的勾選列（沒有照片、也沒勾選的值不顯示） */
  const rowsHtml = (key: FilterKey, rows: [string, string][]) => {
    const c = counts(key);
    let out = "";
    for (const [v, label] of rows) {
      const on = S.filters[key].has(v);
      if (!((c.get(v) ?? 0) > 0 || on)) continue;
      const lc = key === "label" && v !== "none" && v !== "other" ? LABELS.find((l) => l.key === v)?.color : null;
      const dot = lc ? `<span class="dot" style="background:${lc}"></span>` : "";
      out += `<div class="filter-row${on ? " on" : ""}" data-k="${key}" data-v="${escapeHtml(v)}">
        <input type="checkbox" ${on ? "checked" : ""}>${dot}<span class="label">${escapeHtml(label)}</span>
        <span class="n">${c.get(v) ?? 0}</span></div>`;
    }
    return out;
  };
  const labelRows = groups.find((g) => g[0] === "label")?.[2] ?? [];
  for (const [key, title, rows] of groups) {
    // 系統設定裡關掉的篩選組不顯示；標籤併在「評等」裡一起顯示
    if (hiddenGroups.has(key) || key === "label") continue;
    const c = counts(key);
    const visible = rows.filter(([v]) => (c.get(v) ?? 0) > 0 || S.filters[key].has(v));
    // 「調整」：只要有調整過的照片就顯示（即使全部都調整過）
    const always = key === "rating" || key === "suggest" || key === "eyes" || key === "sharp" || (key === "edited" && (c.get("yes") ?? 0) > 0);
    if (!visible.length || (!always && visible.length < 2 && !S.filters[key].size)) continue;
    // 每組都可以收合（狀態記住）；收合時若有勾選，標題旁顯示數量
    const folded = collapsedGroups.has(key);
    const nOn = S.filters[key].size + (key === "rating" ? S.filters.label.size : 0);
    html += `<div class="filter-group foldable${folded ? " folded" : ""}" data-group="${key}"><h4 class="fg-head" title="點一下收合 / 展開">${CHEV}<span>${title}</span>${folded && nOn ? `<span class="fg-on">${nOn}</span>` : ""}</h4>`;
    html += rowsHtml(key, rows);
    if (key === "rating") {
      // 色彩標籤接在星等下面
      const lr = rowsHtml("label", labelRows);
      if (lr) html += `<div class="filter-sep"></div>${lr}`;
    }
    html += `</div>`;
  }
  box.innerHTML = html || `<p class="muted small">開啟資料夾後顯示</p>`;
}

/** 收合的篩選組 / 資料夾區塊（記在本機） */
const collapsedGroups = new Set<string>(storage<string[]>("collapsedGroups", []));
function toggleGroup(key: string) {
  if (collapsedGroups.has(key)) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
  store("collapsedGroups", [...collapsedGroups]);
}

$("filters").addEventListener("click", (ev) => {
  const head = (ev.target as HTMLElement).closest<HTMLElement>(".fg-head");
  if (head) {
    toggleGroup(head.parentElement!.dataset.group!);
    return renderFilters();
  }
  const row = (ev.target as HTMLElement).closest(".filter-row") as HTMLElement | null;
  if (!row) return;
  const set = S.filters[row.dataset.k as FilterKey];
  const v = row.dataset.v!;
  set.has(v) ? set.delete(v) : set.add(v);
  update({ resetGrid: true });
});
$("btn-clear-filter").addEventListener("click", () => {
  for (const k of FILTER_KEYS) S.filters[k].clear();
  update({ resetGrid: true });
});

// ---------------------------------------------------------------- updates

let pendingUpdate = 0;
/** 重新計算檢視並重畫。resetGrid = 排序或篩選改變，需要重新配置格子 */
function update(opts: { resetGrid?: boolean } = {}) {
  recomputeView();
  // 子資料夾排在照片前面（也依評等 / 標籤 / 檔案類型篩選）
  grid.setFolders(visibleFolders());
  renderFilters();
  updateAspect();
  if (opts.resetGrid) grid.reset();
  else grid.render();
  grid.refresh();
  renderStatus();
  if (S.loupe) renderLoupeInfo();
  if (S.compare.length) renderCompare(false);
  if (slideshow.active) slideshow.refreshCaption();
}
/** 大量中繼資料湧入時節流更新 */
function scheduleUpdate() {
  if (pendingUpdate) return;
  pendingUpdate = window.setTimeout(() => {
    pendingUpdate = 0;
    const before = S.view.length;
    const needsReset = FILTER_KEYS.some((k) => S.filters[k].size) || S.sort !== "name";
    update({ resetGrid: needsReset || before !== S.view.length });
  }, 200);
}

/** 依資料夾內照片的方向決定縮圖框形狀：幾乎都是直幅 → 直的框，都是橫幅 → 橫的框，混合 → 正方形 */
function updateAspect() {
  let portrait = 0;
  let landscape = 0;
  for (const it of live()) {
    const m = S.meta.get(it.id);
    if (!m?.width || !m?.height) continue;
    if (m.height > m.width) portrait++;
    else landscape++;
  }
  const n = portrait + landscape;
  grid.setAspect(!n ? 1 : portrait / n >= 0.8 ? 1.5 : landscape / n >= 0.8 ? 2 / 3 : 1);
}

function renderStatus() {
  const total = live().length;
  const shown = S.view.length;
  const sel = S.selected.size;
  $("count").textContent = total
    ? `${shown === total ? `${total} 個項目` : `顯示 ${shown} / ${total}`}${sel > 1 ? ` · 已選取 ${sel}` : ""}`
    : "";
  let p = "";
  if (total && S.metaLoaded < total) p = `讀取中繼資料 ${S.metaLoaded}/${total}`;
  if (cull.running) p += `${p ? " · " : ""}選片分析 ${cull.analysis.size}/${total}`;
  $("progress").textContent = p;
  renderFileInfo();
  prepareDragSoon();
}

/** 選取了有調整的照片 → 背景先做好「套用調整後」的拖曳用檔案（拖曳時不必等） */
const prepareDragSoon = debounce(() => {
  if (!dragBake.checked) return;
  const ids = [...S.selected].filter((id) => S.meta.get(id)?.edited).slice(0, 30);
  if (ids.length) api.prepareDrag(S.session, ids).catch(() => {});
}, 500);

// ---------------------------------------------------------------- 狀態列：目前照片的檔案資訊

const fileInfoCache = new Map<string, FileInfo>();
let fileInfoTimer = 0;

function fmtDateTime(ms: number | null) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fileInfoHtml(id: number, info: FileInfo | undefined) {
  const m = S.meta.get(id);
  const seg: string[] = [];
  if (info) {
    const fmt = info.parts.map((p) => p.ext).join(" + ");
    const size = info.parts.map((p) => fmtBytes(p.size)).join(" + ");
    seg.push(`<b>${escapeHtml(fmt)}</b>`);
    // 相機品牌與型號（讀得到 EXIF 才顯示）
    if (m?.camera) seg.push(escapeHtml(m.camera));
    const w = m?.width || info.width;
    const h = m?.height || info.height;
    if (w && h) seg.push(`${w} × ${h}`);
    seg.push(size);
    seg.push(`建立 ${fmtDateTime(info.created)}`);
    seg.push(`修改 ${fmtDateTime(info.modified)}`);
    if (S.items[id]?.kind !== "text") seg.push(`色彩空間 ${escapeHtml(info.color_space ?? "未標示（視為 sRGB）")}`);
  } else {
    if (m?.camera) seg.push(escapeHtml(m.camera));
    if (m?.width && m?.height) seg.push(`${m.width} × ${m.height}`);
  }
  return seg.map((x) => `<span>${x}</span>`).join("");
}

function renderFileInfo() {
  const el = $("file-info");
  const id = S.focus;
  const it = id !== null ? S.items[id] : undefined;
  if (id === null || !it || S.removed.has(id) || !S.selected.has(id)) {
    el.innerHTML = "";
    el.title = "";
    return;
  }
  const key = `${S.session}:${id}`;
  // 文字檔可能剛在內建編輯器改過：大小、修改時間每次重新讀
  if (it.kind === "text") fileInfoCache.delete(key);
  const cached = fileInfoCache.get(key);
  el.innerHTML = fileInfoHtml(id, cached);
  el.title = it.files.join("\n");
  if (cached) return;
  // 快速按方向鍵瀏覽時不必每張都讀
  clearTimeout(fileInfoTimer);
  const session = S.session;
  fileInfoTimer = window.setTimeout(() => {
    api
      .fileInfo(session, id)
      .then((info) => {
        if (fileInfoCache.size > 2000) fileInfoCache.clear();
        fileInfoCache.set(`${session}:${id}`, info);
        if (S.session === session && S.focus === id) renderFileInfo();
      })
      .catch(() => {});
  }, 80);
}


// ---------------------------------------------------------------- folder

/** 開啟資料夾；成功回傳 true（quiet：失敗時不顯示錯誤，由呼叫端處理） */
async function openFolder(path: string, quiet = false): Promise<boolean> {
  let res: OpenResult;
  try {
    res = await api.openFolder(path);
  } catch (e) {
    if (!quiet) toast(String(e));
    return false;
  }
  setEmptyMessage(null);
  Object.assign(S, {
    session: res.session,
    dir: res.dir,
    parent: res.parent,
    items: res.items,
    subdirs: res.subdirs,
    folderSel: "",
    focus: res.items.length ? 0 : null,
    anchor: res.items.length ? 0 : null,
    metaLoaded: 0,
  });
  S.meta.clear();
  S.overrides.clear();
  S.removed.clear();
  cull.clear();
  S.selected = new Set(res.items.length ? [0] : []);
  for (const k of FILTER_KEYS) S.filters[k].clear();
  flushEarlyMeta();

  const recent = [res.dir, ...storage<string[]>("recent", []).filter((p) => p !== res.dir)].slice(0, 8);
  store("recent", recent);
  store("last", res.dir);
  syncTabDir(res.dir);

  pathInput.value = res.dir;
  pathInput.scrollLeft = pathInput.scrollWidth;
  $("empty").classList.toggle("hidden", true);
  void folderTree.reveal(res.dir); // 資料夾樹維持原狀，只反白目前資料夾並展開到它的位置
  gridEl.scrollTop = 0;
  update({ resetGrid: true });
  gridEl.focus();
  if (!res.items.length && !res.subdirs.length) toast("這個資料夾沒有支援的照片");
  return true;
}

function folderLabel(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** 空白畫面的說明文字（null = 預設） */
function setEmptyMessage(msg: string | null) {
  $("empty").querySelector("p")!.textContent = msg ?? "開啟一個照片資料夾開始選片";
}

/**
 * 開啟資料夾；資料夾已不存在（被刪除、改名、外接硬碟沒接上）時改開最近一層還存在的上層資料夾。
 * 回傳實際開啟的資料夾；連上層都找不到時清空畫面並回傳 null（不會繼續顯示別的資料夾的照片）
 */
async function openFolderOrParent(dir: string): Promise<string | null> {
  if (await openFolder(dir, true)) return S.dir;
  const parent = await api.existingAncestor(dir).catch(() => null);
  if (parent && (await openFolder(parent, true))) {
    toast(`「${folderLabel(dir)}」已不存在，改為顯示上一層「${folderLabel(parent)}」`, 5000);
    return S.dir;
  }
  showMissingFolder(dir);
  return null;
}

/** 找不到資料夾：清空畫面並說明（分頁記錄的路徑保留，外接硬碟接回來後切回分頁就能開） */
function showMissingFolder(dir: string) {
  Object.assign(S, { dir: "", parent: null, items: [], subdirs: [], focus: null, anchor: null, folderSel: "" });
  S.selected = new Set();
  S.meta.clear();
  for (const k of FILTER_KEYS) S.filters[k].clear();
  pathInput.value = dir;
  setEmptyMessage(`找不到資料夾「${folderLabel(dir)}」，可能已被刪除、改名，或外接硬碟沒有接上。`);
  $("empty").classList.remove("hidden");
  update({ resetGrid: true });
  toast(`找不到資料夾「${folderLabel(dir)}」`, 5000);
}

/** 重新整理（⌘R）：重新讀取資料夾（新增 / 變更的檔案），保留選取、篩選與捲動位置，並重新載入縮圖 */
let refreshing = false;
async function refreshFolder() {
  if (!S.dir || refreshing) return;
  refreshing = true;
  try {
    await doRefreshFolder();
  } finally {
    refreshing = false;
  }
}

async function doRefreshFolder(quiet = false) {
  const selNames = new Set([...S.selected].map((id) => S.items[id]?.name));
  const focusName = S.focus !== null ? S.items[S.focus]?.name : undefined;
  const filters = FILTER_KEYS.map((k) => [k, new Set(S.filters[k])] as const);
  const top = gridEl.scrollTop;
  const before = S.dir;
  const opened = await openFolderOrParent(before);
  if (opened !== before) return; // 資料夾已不存在：已改開上一層（或清空畫面）
  for (const [k, v] of filters) S.filters[k] = v;
  const sel = S.items.filter((it) => selNames.has(it.name)).map((it) => it.id);
  if (sel.length) {
    S.selected = new Set(sel);
    const f = S.items.find((it) => it.name === focusName);
    S.focus = f ? f.id : sel[0];
    S.anchor = S.focus;
  }
  update();
  gridEl.scrollTop = top;
  grid.reloadThumbs();
  if (!quiet) toast("已重新整理");
}

// ---------------------------------------------------------------- 分頁（多個資料夾）
// 每個分頁記住自己的資料夾、選取、焦點、篩選、排序與捲動位置；切換分頁時重新開啟那個資料夾並還原
// （縮圖與預覽都在快取裡，切換很快）。分頁清單存在本機，下次開啟沿用。

interface TabState {
  dir: string;
  sel?: string[];
  focus?: string | null;
  anchor?: string | null;
  filters?: Partial<Record<FilterKey, string[]>>;
  sort?: string;
  sortDesc?: boolean;
  scroll?: number;
}

const IS_MAC_UI = /Mac/.test(navigator.platform) || navigator.userAgent.includes("Mac OS X");
let tabs: TabState[] = storage<TabState[]>("tabs", []).filter((t) => t && typeof t.dir === "string" && t.dir);
let activeTab = Math.min(Math.max(0, storage<number>("activeTab", 0)), Math.max(0, tabs.length - 1));
let switchingTab = false;

function saveTabs() {
  store("tabs", tabs);
  store("activeTab", activeTab);
}

/** 目前畫面的狀態 → 分頁記錄 */
function captureTab(): TabState {
  const name = (id: number | null) => (id !== null ? (S.items[id]?.name ?? null) : null);
  return {
    dir: S.dir,
    sel: [...S.selected].map((id) => S.items[id]?.name).filter((n): n is string => !!n),
    focus: name(S.focus),
    anchor: name(S.anchor),
    filters: Object.fromEntries(FILTER_KEYS.filter((k) => S.filters[k].size).map((k) => [k, [...S.filters[k]]])),
    sort: S.sort,
    sortDesc: S.sortDesc,
    scroll: gridEl.scrollTop,
  };
}

/** 開完資料夾後，還原分頁記住的選取、篩選、排序與捲動 */
function restoreTab(t: TabState) {
  const byName = new Map(S.items.map((it) => [it.name, it.id]));
  for (const k of FILTER_KEYS) S.filters[k] = new Set(t.filters?.[k] ?? []);
  if (t.sort) {
    S.sort = t.sort;
    $<HTMLSelectElement>("sort").value = t.sort;
  }
  if (typeof t.sortDesc === "boolean") {
    S.sortDesc = t.sortDesc;
    $("sort-dir").textContent = S.sortDesc ? "↑" : "↓";
  }
  const sel = (t.sel ?? []).map((n) => byName.get(n)).filter((id): id is number => id !== undefined);
  if (sel.length) S.selected = new Set(sel);
  const f = t.focus ? byName.get(t.focus) : undefined;
  if (f !== undefined) S.focus = f;
  const a = t.anchor ? byName.get(t.anchor) : undefined;
  S.anchor = a ?? S.focus;
  renderFilters();
  update({ resetGrid: true });
  const top = t.scroll ?? 0;
  requestAnimationFrame(() => {
    gridEl.scrollTop = top;
    grid.refreshViewport();
  });
}

/** 開資料夾後：目前分頁改成這個資料夾（沒有分頁時建立第一個） */
function syncTabDir(dir: string) {
  if (!tabs.length) {
    tabs = [{ dir }];
    activeTab = 0;
  } else if (!switchingTab) tabs[activeTab] = { ...tabs[activeTab], dir };
  saveTabs();
  renderTabs();
}

function canSwitchTab() {
  if (editor.isOpen) return toast("請先關閉調整視窗"), false;
  if (slideshow.active) return toast("請先結束幻燈片"), false;
  if (S.loupe) closeLoupe();
  if (S.compare.length) closeCompare();
  return true;
}

async function switchTab(i: number) {
  if (i === activeTab || i < 0 || i >= tabs.length || !canSwitchTab()) return;
  if (S.dir) tabs[activeTab] = captureTab();
  activeTab = i;
  await openTab(tabs[i]);
}

async function openTab(t: TabState) {
  switchingTab = true;
  try {
    renderTabs();
    const opened = await openFolderOrParent(t.dir);
    if (opened === t.dir) restoreTab(t);
    else if (opened) {
      // 改開了上層資料夾：分頁跟著換成這個資料夾（原本的選取、捲動位置不適用）
      Object.assign(t, { dir: opened, sel: [], focus: null, anchor: null, scroll: 0 });
      tabs[activeTab] = t;
    }
  } finally {
    switchingTab = false;
  }
  saveTabs();
  renderTabs();
}

/** 開新分頁（預設開同一個資料夾，之後在新分頁裡換資料夾即可） */
async function newTab(dir?: string) {
  if (!canSwitchTab()) return;
  const target = dir ?? S.dir;
  if (!target) return pickFolder();
  if (S.dir && tabs.length) tabs[activeTab] = captureTab();
  tabs.push({ dir: target });
  activeTab = tabs.length - 1;
  await openTab(tabs[activeTab]);
}

async function closeTab(i: number) {
  if (tabs.length <= 1) return toast("至少要保留一個分頁");
  if (i === activeTab && !canSwitchTab()) return;
  tabs.splice(i, 1);
  if (i < activeTab) {
    activeTab--;
    saveTabs();
    return renderTabs();
  }
  if (i > activeTab) {
    saveTabs();
    return renderTabs();
  }
  activeTab = Math.min(i, tabs.length - 1);
  await openTab(tabs[activeTab]);
}

function tabName(dir: string) {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function renderTabs() {
  const bar = $("tabbar");
  bar.innerHTML =
    tabs
      .map(
        (t, i) =>
          `<div class="tab${i === activeTab ? " active" : ""}" data-tab="${i}" title="${escapeHtml(t.dir)}${i < 9 ? `（⌘${i + 1}）` : ""}"><span class="tab-name">${escapeHtml(tabName(t.dir))}</span>${tabs.length > 1 ? `<button class="tab-x" data-close="${i}" title="關閉分頁（⌘W）">✕</button>` : ""}</div>`,
      )
      .join("") + `<button id="tab-new" class="tab-new" title="新增分頁（⌘T）">＋</button>`;
}

// ---- 把照片拖到其他分頁 = 複製 / 移動到那個分頁的資料夾
// 縮圖拖曳是系統原生拖曳（也能拖到 Finder 等其他程式），所以在視窗的 drop 事件裡判斷放在哪個分頁上

/** macOS 拖放座標含標題列（紅黃綠按鈕那一條）的高度：量一次標題列高度，換算成網頁座標時扣掉 */
let titleBarH = 0;
async function measureTitleBar() {
  if (!IS_MAC_UI) return;
  try {
    const w = getCurrentWindow();
    const [inner, outer, sf] = await Promise.all([w.innerPosition(), w.outerPosition(), w.scaleFactor()]);
    const h = (inner.y - outer.y) / (sf || 1);
    titleBarH = h > 0 && h < 120 ? h : 28;
  } catch {
    titleBarH = 28;
  }
}
void measureTitleBar();
window.addEventListener("resize", () => void measureTitleBar());

/** 視窗座標（實體像素）下的分頁索引；不在分頁上回傳 -1 */
function tabAt(pos: { x: number; y: number } | undefined): number {
  if (!pos) return -1;
  if (IS_MAC_UI) {
    // macOS：座標是點（不必除倍率），而且從視窗最上緣（含標題列）算起
    const el = document.elementFromPoint(pos.x, pos.y - titleBarH) as HTMLElement | null;
    const t = el?.closest<HTMLElement>("[data-tab]");
    return t ? Number(t.dataset.tab) : -1;
  }
  // macOS 回報的拖放座標已經是點（邏輯像素），其他系統是實體像素
  const dpr = IS_MAC_UI ? 1 : window.devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr) as HTMLElement | null;
  const t = el?.closest<HTMLElement>("[data-tab]");
  return t ? Number(t.dataset.tab) : -1;
}

function markDropTab(i: number) {
  document.querySelectorAll<HTMLElement>("#tabbar [data-tab]").forEach((t) => t.classList.toggle("drop-target", Number(t.dataset.tab) === i && i !== activeTab));
}

/** 放到分頁上：問要複製還是移動（仿 Finder 的右鍵拖曳選單） */
function dropOnTab(i: number, ids: number[]) {
  const t = tabs[i];
  if (!t || i === activeTab || !ids.length) return;
  if (t.dir === S.dir) return toast("這個分頁和目前是同一個資料夾");
  const tabEl = document.querySelector<HTMLElement>(`#tabbar [data-tab="${i}"]`);
  const r = tabEl?.getBoundingClientRect();
  const menu = $("tab-drop-menu");
  $("tab-drop-title").textContent = `${ids.length} 個項目 → 「${tabName(t.dir)}」`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 230, r ? r.left : 100))}px`;
  menu.style.top = `${r ? r.bottom + 4 : 80}px`;
  menu.classList.remove("hidden");
  const done = (mode: "copy" | "move" | null) => {
    menu.classList.add("hidden");
    menu.onclick = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onAway, true);
    if (mode) void transferIds(ids, t.dir, mode, false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") e.preventDefault(), e.stopPropagation(), done(null);
    if (e.key === "Enter") e.preventDefault(), e.stopPropagation(), done("copy");
  };
  const onAway = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) done(null);
  };
  menu.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-drop]");
    if (b) done(b.dataset.drop === "cancel" ? null : (b.dataset.drop as "copy" | "move"));
  };
  setTimeout(() => {
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onAway, true);
  }, 0);
}

/** 拖曳開始時的照片（放下時選取可能已改變）與拖出去的檔案路徑（用來認出「自己的拖曳」） */
let dragIds: number[] = [];
let dragFiles = new Set<string>();
let dragAt = 0;

$("tabbar").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const x = t.closest<HTMLElement>("[data-close]");
  if (x) return void closeTab(Number(x.dataset.close));
  if (t.closest("#tab-new")) return void newTab();
  const tab = t.closest<HTMLElement>("[data-tab]");
  if (tab) void switchTab(Number(tab.dataset.tab));
});
// 中鍵點分頁 = 關閉（與瀏覽器相同）
$("tabbar").addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
  if (tab) void closeTab(Number(tab.dataset.tab));
});
// 雙擊分頁列空白處 = 新分頁
$("tabbar").addEventListener("dblclick", (e) => {
  if (e.target === $("tabbar")) void newTab();
});

/** 重新產生選取照片的縮圖（刪掉快取重新讀取原檔） */
async function regenerateThumbs() {
  const ids = [...S.selected];
  if (!ids.length) return toast("請先選取照片");
  try {
    await api.forgetThumbs(S.session, ids);
  } catch (e) {
    return toast(`無法重新產生縮圖：${e}`);
  }
  grid.reloadThumbs(new Set(ids));
  toast(`正在重新產生 ${ids.length} 張縮圖`);
}

async function pickFolder() {
  const dir = await openDialog({ directory: true, defaultPath: S.dir || undefined });
  if (typeof dir === "string") openFolder(dir);
}

const folderTree = new FolderTree($("folder-tree"), (path, ev) => {
  // ⌘ / Ctrl + 點資料夾：在新分頁開啟
  if (ev && (ev.metaKey || ev.ctrlKey)) return void newTab(path);
  if (path !== S.dir) void openFolder(path);
});
$("tree-refresh").addEventListener("click", () => void folderTree.refresh());
// 左側資料夾也可以拖到分頁列的「＋」開新分頁
$("folder-tree").addEventListener("mousedown", (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>(".tree-row");
  if (!row || ev.button !== 0 || !row.dataset.path) return;
  startFolderDrag(row.dataset.path, row.querySelector(".nm")?.textContent ?? row.dataset.path, ev);
});
$("btn-open").addEventListener("click", pickFolder);
$("btn-open-2").addEventListener("click", pickFolder);
// 資料夾區塊收合
{
  const sec = $("folder-tree").closest("section")!;
  sec.classList.add("folder-sec");
  const h3 = sec.querySelector("h3")!;
  h3.classList.add("fg-head");
  h3.insertAdjacentHTML("afterbegin", `<svg class="fg-chev" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  const apply = () => sec.classList.toggle("folded", collapsedGroups.has("folders"));
  apply();
  h3.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    toggleGroup("folders");
    apply();
  });
}

$("btn-up").addEventListener("click", () => S.parent && openFolder(S.parent));
$("btn-refresh").addEventListener("click", () => void refreshFolder());
$("recent").addEventListener("click", (ev) => {
  const li = (ev.target as HTMLElement).closest("li") as HTMLElement | null;
  if (li?.dataset.path) openFolder(li.dataset.path);
});

// 小資料夾的中繼資料可能在「開啟資料夾」的回應之前就送到（此時還不知道新的 session），
// 先暫存，等 openFolder 設定好 session 再套用，避免評等、標籤沒有顯示
const earlyMeta: { session: number; metas?: [number, Meta][]; done?: boolean }[] = [];

function applyMetaBatch(metas: [number, Meta][]) {
  for (const [id, m] of metas) {
    const o = S.overrides.get(id);
    S.meta.set(id, o ? { ...m, ...o } : m);
  }
  S.metaLoaded += metas.length;
  scheduleUpdate();
  // 焦點那張的相機資訊剛讀到：更新最下面的檔案資訊
  if (S.focus !== null && metas.some(([id]) => id === S.focus)) renderFileInfo();
}

function flushEarlyMeta() {
  const mine = earlyMeta.filter((e) => e.session === S.session);
  earlyMeta.length = 0;
  for (const e of mine) {
    if (e.metas) applyMetaBatch(e.metas);
    if (e.done) {
      S.metaLoaded = S.items.length;
      scheduleUpdate();
    }
  }
}

on<{ session: number; metas: [number, Meta][] }>("meta-batch", (e) => {
  if (e.payload.session > S.session) return void earlyMeta.push({ session: e.payload.session, metas: e.payload.metas });
  if (e.payload.session !== S.session) return;
  applyMetaBatch(e.payload.metas);
});
on<number>("meta-done", (e) => {
  if (e.payload > S.session) return void earlyMeta.push({ session: e.payload, done: true });
  if (e.payload !== S.session) return;
  S.metaLoaded = S.items.length;
  scheduleUpdate();
});

// ---------------------------------------------------------------- 選片分析

// 「選片分析」功能已從介面移除（後端程式保留，未來需要時可再開啟）

on<{ session: number; results: [number, Analysis][] }>("analysis-batch", (e) => {
  if (e.payload.session !== S.session) return;
  for (const [id, a] of e.payload.results) cull.add(id, a);
  cull.recompute();
  scheduleUpdate();
  if (S.loupe && e.payload.results.some(([id]) => id === S.focus)) renderFaces();
});
on<number>("analysis-done", (e) => {
  if (e.payload !== S.session) return;
  cull.running = false;
  cull.recompute();
  const n = live().filter((i) => cull.issues(i.id)?.cull).length;
  toast(`選片分析完成：${n} 張建議淘汰（左側「選片建議」可篩選）`, 4000);
  update({ resetGrid: true });
});


// ---------------------------------------------------------------- selection

// 在縮圖上選到一張照片時，背景先準備它的全螢幕預覽，按空白鍵時多半已經好了
const gridPrefetched: unknown[] = [];
const prefetchFocus = debounce((id: number) => {
  if (S.loupe || S.focus !== id) return;
  gridPrefetched.length = 0;
  prefetchImg(url.medium(S.session, id), gridPrefetched);
  prefetchImg(url.preview(S.session, id), gridPrefetched);
}, 350);

function setFocus(id: number, extend: boolean) {
  // 回到照片：取消資料夾的選取
  if (S.folderSel) grid.selectFolder("");
  S.focus = id;
  if (!S.loupe) prefetchFocus(id);
  if (extend && S.anchor !== null && S.viewIndex.has(S.anchor)) {
    const a = S.viewIndex.get(S.anchor)!;
    const b = S.viewIndex.get(id)!;
    S.selected = new Set(S.view.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.id));
  } else {
    S.selected = new Set([id]);
    S.anchor = id;
  }
  const idx = S.viewIndex.get(id);
  if (idx !== undefined) grid.scrollToIndex(idx);
  grid.render();
  grid.refresh();
  renderStatus();
  if (S.loupe) showLoupe();
}

function onCellClick(index: number, ev: MouseEvent) {
  const id = S.view[index].id;
  gridEl.focus();
  if (ev.shiftKey) {
    setFocus(id, true);
  } else if (ev.ctrlKey || ev.metaKey) {
    S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
    S.focus = id;
    S.anchor = id;
    grid.refresh();
    renderStatus();
  } else if (S.selected.has(id) && S.selected.size > 1) {
    // 在多選中的某張上按下：先保留整組選取（可能要拖曳到其他程式），
    // 放開時若沒有拖曳才改成只選這一張（與 Finder / Bridge 相同）
    if (ev.button === 0) pendingCollapse = id;
  } else {
    setFocus(id, false);
  }
}

let pendingCollapse: number | null = null;

function onCellUp(index: number) {
  const id = S.view[index]?.id;
  if (pendingCollapse !== null && pendingCollapse === id) setFocus(id, false);
  pendingCollapse = null;
}

// ---------------------------------------------------------------- 拖曳到其他程式

const dragRaw = $<HTMLInputElement>("drag-raw");
dragRaw.checked = storage("dragRaw", false);
dragRaw.addEventListener("change", () => store("dragRaw", dragRaw.checked));

let dragging = false;

/** 把目前選取的照片（依畫面順序）拖到 Finder、LINE、瀏覽器、Photoshop… */
async function onCellDrag(index: number) {
  pendingCollapse = null;
  const id = S.view[index]?.id;
  if (id === undefined || dragging) return;
  if (!S.selected.has(id)) setFocus(id, false);
  const ids = S.view.filter((it) => S.selected.has(it.id)).map((it) => it.id);
  if (!ids.length) return;
  dragging = true;
  dragIds = ids;
  try {
    const edited = dragBake.checked && ids.some((id) => S.meta.get(id)?.edited);
    if (edited) document.body.style.cursor = "progress";
    const { files, icon } = await api.dragPrepare(S.session, ids, dragRaw.checked, dragBake.checked).finally(() => {
      document.body.style.cursor = "";
    });
    dragFiles = new Set(files);
    dragAt = Date.now();
    await startDrag({ item: files, icon, mode: "copy" });
  } catch (e) {
    console.warn("drag failed", e);
  } finally {
    dragging = false;
  }
}

function moveFocus(delta: number, extend = false) {
  if (!S.view.length) return;
  const cur = S.focus !== null ? (S.viewIndex.get(S.focus) ?? 0) : -1;
  const next = Math.max(0, Math.min(S.view.length - 1, cur + delta));
  setFocus(S.view[next].id, extend);
}

/** 評分 / 標籤要套用的對象 */
// ---------------------------------------------------------------- 刪除（移到垃圾桶）

function settingBox(id: string, key: string, def: boolean) {
  const el = $<HTMLInputElement>(id);
  el.checked = storage(key, def);
  el.addEventListener("change", () => store(key, el.checked));
  return el;
}
const transferBake = settingBox("transfer-bake", "transferBake", true);
const renameBake = settingBox("rename-bake", "renameBake", true);
const dragBake = settingBox("drag-bake", "dragBake", true);
const zipBake = settingBox("zip-bake", "zipBake", true);
const zipRaw = settingBox("zip-raw", "zipRaw", false);

// 系統設定：左側要顯示哪些篩選組（調整 / 相機 / 鏡頭）
const hiddenGroups = new Set<string>(storage<string[]>("hiddenFilterGroups", []));
document.querySelectorAll<HTMLInputElement>("[data-show-group]").forEach((cb) => {
  const k = cb.dataset.showGroup!;
  cb.checked = !hiddenGroups.has(k);
  cb.addEventListener("change", () => {
    if (cb.checked) hiddenGroups.delete(k);
    else {
      hiddenGroups.add(k);
      // 隱藏時一併清掉這組的勾選，避免看不到的篩選還在作用
      if (S.filters[k as FilterKey].size) {
        S.filters[k as FilterKey].clear();
        update({ resetGrid: true });
      }
    }
    store("hiddenFilterGroups", [...hiddenGroups]);
    renderFilters();
  });
});

const confirmDelete = $<HTMLInputElement>("confirm-delete");
confirmDelete.checked = storage("confirmDelete", true);
confirmDelete.addEventListener("change", () => store("confirmDelete", confirmDelete.checked));
let deleting = false;

async function deleteTargets() {
  const ids = targets();
  if (!ids.length || deleting) return;
  const files = ids.reduce((n, id) => n + S.items[id].files.length, 0);
  const what = ids.length === 1 ? `「${S.items[ids[0]].name}」` : `${ids.length} 張照片`;
  if (confirmDelete.checked) {
    const extra = files > ids.length ? `（含配對的 RAW/JPEG，共 ${files} 個檔案）` : "";
    const ok = await ask(`把${what}${extra}移到垃圾桶？\n需要時可以從垃圾桶復原。`, {
      title: "刪除照片",
      kind: "warning",
      okLabel: "移到垃圾桶",
      cancelLabel: "取消",
    });
    if (!ok) return;
  }
  deleting = true;
  try {
    const r = await api.deleteItems(S.session, ids);
    const failedNames = new Set(r.failed.map((f) => f.split("：")[0]));
    const gone = ids.filter((id) => !failedNames.has(S.items[id].name));
    gone.forEach((id) => S.removed.add(id));
    // 停在同一個資料夾，焦點移到原本位置的下一張（recomputeView 會處理）
    if (S.loupe && !live().length) closeLoupe();
    update({ resetGrid: true }); // 重新排版（保留捲動位置）
    if (S.loupe) showLoupe();
    if (r.failed.length) {
      console.warn(r.failed);
      const perm = r.failed.some((f) => f.includes("沒有權限"));
      const isMac = /Mac/.test(navigator.platform) || navigator.userAgent.includes("Mac OS X");
      const names = r.failed.slice(0, 3).map((f) => f.split("：")[0]).join("、") + (r.failed.length > 3 ? "…" : "");
      toast(
        `有 ${r.failed.length} 個項目無法刪除（${names}）` +
          (perm && isMac
            ? "：沒有權限。請到「系統設定 → 隱私權與安全性 → 自動化」允許小日子寫真館控制 Finder，或在「檔案與檔案夾」允許存取該資料夾後再試一次。"
            : perm
              ? "：沒有權限。"
              : `：${r.failed[0].split("：").slice(1).join("：")}`),
        10000,
      );
    }
    else toast(`已將${what}移到垃圾桶`, 2000);
  } catch (e) {
    toast(`刪除失敗：${e}`);
  } finally {
    deleting = false;
  }
}

function targets(): number[] {
  // 選了資料夾：照片相關的動作（評等、刪除、旋轉…）都不作用在照片上
  if (S.folderSel && !S.loupe && !S.compare.length && !slideshow.active) return [];
  if (slideshow.active) {
    const id = slideshow.currentId();
    return id === null ? [] : [id];
  }
  if (S.compare.length) return [S.compare[S.compareActive]];
  if (S.loupe) return S.focus !== null ? [S.focus] : [];
  if (S.focus !== null && S.selected.has(S.focus) && S.selected.size > 1) return [...S.selected];
  return S.focus !== null ? [S.focus] : [];
}

function setLocal(id: number, patch: Partial<Meta>) {
  Object.assign(metaOf(id), patch);
  S.overrides.set(id, { ...(S.overrides.get(id) ?? {}), ...patch });
}

async function applyRating(rating: number | "toggle-reject") {
  const ids = targets();
  if (!ids.length) return;
  let value: number;
  if (rating === "toggle-reject") value = ids.every((id) => metaOf(id).rating < 0) ? 0 : -1;
  else value = rating;
  const prev = ids.map((id) => [id, metaOf(id).rating] as const);
  const advanceTo = advanceTarget(ids);
  ids.forEach((id) => setLocal(id, { rating: value }));
  afterEdit(advanceTo);
  try {
    await api.setRating(S.session, ids, value);
  } catch (e) {
    prev.forEach(([id, r]) => setLocal(id, { rating: r }));
    update();
    toast(`寫入評等失敗：${e}`);
  }
}

async function applyLabel(key: LabelKey) {
  const ids = targets();
  if (!ids.length) return;
  // 與 Bridge 相同：再按一次同色就移除標籤。寫入的文字使用設定的標籤名稱
  const value = ids.every((id) => labelKey(metaOf(id).label) === key) ? null : labelName(key);
  const prev = ids.map((id) => [id, metaOf(id).label ?? null] as const);
  const advanceTo = advanceTarget(ids);
  ids.forEach((id) => setLocal(id, { label: value }));
  afterEdit(advanceTo);
  try {
    await api.setLabel(S.session, ids, value);
  } catch (e) {
    prev.forEach(([id, l]) => setLocal(id, { label: l }));
    update();
    toast(`寫入標籤失敗：${e}`);
  }
}

/** 資料夾評等（寫在資料夾裡的隱藏檔） */
async function rateFolder(rating: number | "toggle-reject") {
  const d = S.subdirs.find((x) => x.path === S.folderSel);
  if (!d) return;
  const prev = d.rating ?? 0;
  const value = rating === "toggle-reject" ? (prev < 0 ? 0 : -1) : rating;
  d.rating = value;
  update();
  try {
    await api.setFolderRating(d.path, value);
  } catch (e) {
    d.rating = prev;
    update();
    toast(String(e));
  }
}

/** 資料夾標籤：再按一次同色就移除（與照片相同） */
async function labelFolder(key: LabelKey) {
  const d = S.subdirs.find((x) => x.path === S.folderSel);
  if (!d) return;
  const prev = d.label ?? null;
  const value = labelKey(prev) === key ? null : labelName(key);
  d.label = value;
  update();
  try {
    await api.setFolderLabel(d.path, value);
  } catch (e) {
    d.label = prev;
    update();
    toast(String(e));
  }
}

function advanceTarget(ids: number[]): number | null {
  if (!($("auto-advance") as HTMLInputElement).checked || ids.length !== 1 || S.compare.length || slideshow.active) return null;
  const i = S.viewIndex.get(ids[0]);
  return i !== undefined && i + 1 < S.view.length ? S.view[i + 1].id : null;
}

function afterEdit(advanceTo: number | null) {
  update();
  if (advanceTo !== null && S.viewIndex.has(advanceTo)) setFocus(advanceTo, false);
}

// ---------------------------------------------------------------- loupe

const loupe = $("loupe");
const loupeImg = $<HTMLImageElement>("loupe-img");
const stage = $("loupe-stage");
const prefetched: unknown[] = [];
const faceLayer = $("loupe-faces");
let showFaces = storage("showFaces", true);

function renderFaces() {
  if (!S.loupe || S.zoom || !showFaces || S.focus === null) {
    faceLayer.innerHTML = "";
    return;
  }
  drawFaces(faceLayer, loupeImg, cull.analysis.get(S.focus), cull, S.focus);
}
loupeImg.addEventListener("load", renderFaces);
window.addEventListener("resize", () => S.loupe && renderFaces());

function openLoupe() {
  if (S.focus === null) return;
  S.loupe = true;
  loupe.classList.remove("hidden");
  showLoupe();
}

function closeLoupe() {
  S.loupe = false;
  S.zoom = false;
  stage.classList.remove("zoom");
  loupe.classList.add("hidden");
  chain = null;
  hideLoupeText();
  clearImg(loupeImg);
  faceLayer.innerHTML = "";
  gridEl.focus();
}

const loupeText = $("loupe-text");
const loupeTextBody = $("loupe-text-body");
let loupeTextSeq = 0;

/** 文字檔的預覽：顯示完整內容（可捲動） */
function showLoupeText(id: number) {
  const seq = ++loupeTextSeq;
  chain = null;
  clearImg(loupeImg);
  stage.classList.add("hidden");
  loupeText.classList.remove("hidden");
  loupeTextBody.textContent = "讀取中…";
  api
    .readText(S.session, id)
    .then((r) => {
      if (seq !== loupeTextSeq) return;
      loupeTextBody.textContent = r.text || "（空白）";
      loupeTextBody.classList.toggle("empty", !r.text);
      loupeText.scrollTop = 0;
    })
    .catch((e) => {
      if (seq === loupeTextSeq) loupeTextBody.textContent = `無法讀取：${e}`;
    });
}

function hideLoupeText() {
  loupeTextSeq++;
  loupeText.classList.add("hidden");
  stage.classList.remove("hidden");
}

$("loupe-text-edit").addEventListener("click", () => {
  if (S.focus !== null) void textEditor.openEdit(S.session, S.focus);
});
loupeText.addEventListener("dblclick", () => {
  if (S.focus !== null) void textEditor.openEdit(S.session, S.focus);
});

function showLoupe() {
  if (S.focus === null) return;
  S.zoom = false;
  stage.classList.remove("zoom");
  faceLayer.innerHTML = "";
  if (S.items[S.focus]?.kind === "text") showLoupeText(S.focus);
  else {
    hideLoupeText();
    startChain(S.focus);
  }
  renderLoupeInfo();
  // 預先載入前後兩張，翻頁時幾乎零等待
  prefetched.length = 0;
  const i = S.viewIndex.get(S.focus) ?? 0;
  for (const d of [1, -1, 2, -2]) {
    const n = S.view[i + d];
    if (!n) continue;
    prefetchImg(url.medium(S.session, n.id), prefetched);
    if (Math.abs(d) === 1) prefetchImg(url.preview(S.session, n.id), prefetched);
  }
}

// 全螢幕分段顯示：縮圖（立即，已在快取）→ 中等預覽（相機內嵌，很快）→ 完整預覽（2560px）。
// 每一段載入完成才換下一段；換圖期間畫面保留上一段，不會出現黑畫面。
let chain: { id: number; steps: string[]; i: number } | null = null;

function startChain(id: number) {
  chain = { id, steps: [url.thumb(S.session, id), url.medium(S.session, id), url.preview(S.session, id)], i: 0 };
  stepChain();
}

function stepChain() {
  const c = chain;
  if (!c || S.zoom || !S.loupe) return;
  if (c.i >= c.steps.length) {
    chain = null;
    return;
  }
  const u = c.steps[c.i];
  setImg(loupeImg, u, () => {
    // 這一段載入失敗（例如縮圖被取消）→ 直接跳下一段
    if (chain === c && c.steps[c.i] === u) {
      c.i++;
      stepChain();
    }
  });
}

loupeImg.addEventListener("load", () => {
  const c = chain;
  if (c && loupeImg.dataset.want === c.steps[c.i]) {
    c.i++;
    stepChain();
  }
});

function renderLoupeInfo() {
  if (S.focus === null) return;
  const it = S.items[S.focus];
  const m = S.meta.get(it.id);
  const lc = labelColor(m?.label);
  const i = (S.viewIndex.get(it.id) ?? 0) + 1;
  $("loupe-info").innerHTML =
    `<span>${i} / ${S.view.length}</span><b>${escapeHtml(it.name)}</b>` +
    `<span class="stars${(m?.rating ?? 0) < 0 ? " rej" : ""}">${stars(m?.rating ?? 0)}</span>` +
    (lc ? `<span class="dot" style="background:${lc}"></span>` : "") +
    cull.badges(it.id) +
    `<span class="muted">${[m?.shutter, m?.aperture && `f/${m.aperture}`, m?.iso && `ISO ${m.iso}`, m?.focal && `${m.focal}mm`]
      .filter(Boolean)
      .join(" · ")}</span>`;
}

function toggleZoom(ev?: MouseEvent) {
  if (S.focus === null || S.items[S.focus]?.kind === "text") return;
  S.zoom = !S.zoom;
  chain = null;
  faceLayer.innerHTML = "";
  if (!S.zoom) {
    stage.classList.remove("zoom");
    setImg(loupeImg, url.preview(S.session, S.focus));
    return;
  }
  // 以點擊位置為中心放大到 100%
  const r = contentRect(loupeImg);
  const fx = ev ? (ev.clientX - r.left) / r.width : 0.5;
  const fy = ev ? (ev.clientY - r.top) / r.height : 0.5;
  stage.classList.add("zoom");
  setImg(loupeImg, url.full(S.session, S.focus));
  loupeImg.onload = () => {
    loupeImg.onload = null;
    if (!S.zoom) return;
    stage.scrollLeft = loupeImg.naturalWidth * fx - stage.clientWidth / 2;
    stage.scrollTop = loupeImg.naturalHeight * fy - stage.clientHeight / 2;
  };
}
loupeImg.addEventListener("click", (ev) => toggleZoom(ev));

// ---------------------------------------------------------------- compare

const compareEl = $("compare");

function openCompare() {
  const ids = (S.selected.size >= 2 ? S.view.filter((i) => S.selected.has(i.id)).map((i) => i.id) : []).slice(0, 4);
  if (ids.length < 2) {
    toast("請先選取 2–4 張照片（Ctrl / Shift + 點選）再按 C");
    return;
  }
  S.compare = ids;
  S.compareActive = Math.max(0, ids.indexOf(S.focus ?? -1));
  compareEl.classList.remove("hidden");
  renderCompare(true);
}

function closeCompare() {
  S.compare = [];
  compareEl.classList.add("hidden");
  $("compare-grid").innerHTML = "";
  gridEl.focus();
}

function renderCompare(rebuild: boolean) {
  const g = $("compare-grid");
  const n = S.compare.length;
  if (rebuild) {
    g.style.gridTemplateColumns = `repeat(${n <= 3 ? n : 2}, 1fr)`;
    g.style.gridTemplateRows = n === 4 ? "1fr 1fr" : "1fr";
    g.innerHTML = S.compare
      .map((id, i) => `<div class="cmp" data-i="${i}"><img data-id="${id}" alt=""><div class="overlay-info"></div></div>`)
      .join("");
    g.querySelectorAll<HTMLImageElement>("img[data-id]").forEach((im) =>
      setImg(im, url.preview(S.session, Number(im.dataset.id))),
    );
  }
  g.querySelectorAll<HTMLElement>(".cmp").forEach((el, i) => {
    const id = S.compare[i];
    const m = S.meta.get(id);
    const lc = labelColor(m?.label);
    el.classList.toggle("active", i === S.compareActive);
    el.querySelector(".overlay-info")!.innerHTML =
      `<b>${escapeHtml(S.items[id].name)}</b><span class="stars${(m?.rating ?? 0) < 0 ? " rej" : ""}">${stars(m?.rating ?? 0)}</span>` +
      (lc ? `<span class="dot" style="background:${lc}"></span>` : "") +
      cull.badges(id);
  });
}

$("compare-grid").addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest(".cmp") as HTMLElement | null;
  if (!el) return;
  S.compareActive = Number(el.dataset.i);
  renderCompare(false);
});

// ---------------------------------------------------------------- transfer

async function transfer(mode: "copy" | "move") {
  const ids = S.selected.size ? [...S.selected] : S.focus !== null ? [S.focus] : [];
  if (!ids.length) return toast("沒有選取任何照片");
  const dest = await openDialog({ directory: true, title: mode === "copy" ? "複製到…" : "移動到…" });
  if (typeof dest !== "string") return;
  await transferIds(ids, dest, mode);
}

/** 複製 / 移動指定的照片到 dest（含配對 RAW/JPEG 與 .xmp；依設定套用調整） */
async function transferIds(ids: number[], dest: string, mode: "copy" | "move", confirmMove = true) {
  if (dest === S.dir) return toast("目的地就是目前的資料夾");
  const editedCount = transferBake.checked ? ids.filter((id) => S.meta.get(id)?.edited).length : 0;
  const bakeNote = editedCount
    ? `\n\n其中 ${editedCount} 張有調整過：會在目的地輸出套用調整後的照片${mode === "move" ? "，原本未調整的原檔移到垃圾桶" : ""}。`
    : "";
  if (mode === "move" && confirmMove && !(await ask(`確定要把 ${ids.length} 個項目（含配對的 RAW/JPEG 與 .xmp）移動到\n${dest}？${bakeNote}`, { title: "移動檔案", okLabel: "確定", cancelLabel: "取消" })))
    return;
  if (editedCount) toast(`正在輸出 ${editedCount} 張套用調整後的照片…`, 60000);
  try {
    const r = await api.transfer(S.session, ids, dest, mode, transferBake.checked);
    notify(
      `${mode === "copy" ? "已複製" : "已移動"} ${r.done} 個項目到「${folderName(dest)}」${r.failed.length ? `，${r.failed.length} 個檔案失敗` : ""}`,
      r.done ? openDirAction(dest) : undefined,
    );
    if (r.failed.length) console.warn(r.failed);
    if (mode === "move") {
      const top = gridEl.scrollTop;
      await openFolder(S.dir);
      gridEl.scrollTop = top;
    }
  } catch (e) {
    toast(String(e));
  }
}
$("btn-copy").addEventListener("click", () => transfer("copy"));
$("btn-move").addEventListener("click", () => transfer("move"));

// ---------------------------------------------------------------- toolbar

const sizeInput = $<HTMLInputElement>("size");
sizeInput.value = String(storage("thumbSize", 180));
grid.setSize(Number(sizeInput.value));
sizeInput.addEventListener("input", () => {
  grid.setSize(Number(sizeInput.value));
  store("thumbSize", Number(sizeInput.value));
});
function bumpSize(d: number) {
  sizeInput.value = String(Math.max(100, Math.min(380, Number(sizeInput.value) + d)));
  sizeInput.dispatchEvent(new Event("input"));
}

const autoAdv = $<HTMLInputElement>("auto-advance");
autoAdv.checked = storage("autoAdvance", true);
autoAdv.addEventListener("change", () => store("autoAdvance", autoAdv.checked));

$<HTMLSelectElement>("sort").addEventListener("change", (e) => {
  S.sort = (e.target as HTMLSelectElement).value;
  update({ resetGrid: true });
});
$("sort-dir").addEventListener("click", () => {
  S.sortDesc = !S.sortDesc;
  $("sort-dir").textContent = S.sortDesc ? "↑" : "↓";
  update({ resetGrid: true });
});


// ---------------------------------------------------------------- 文字檔（內建簡易編輯器）

const textEditor = new TextEditor({
  toast: (m) => toast(m),
  closed: () => gridEl.focus(),
  saved: (r) => {
    if (r.kind === "edit") {
      grid.reloadThumbs(new Set([r.id]));
      if (S.loupe && S.focus === r.id) showLoupe();
      return;
    }
    // 新檔案：重新讀取資料夾（保留篩選與選取），再選取新檔案
    void (async () => {
      await doRefreshFolder(true);
      const it = S.items.find((i) => i.name === r.name);
      if (it && S.viewIndex.has(it.id)) setFocus(it.id, false);
      else if (it) toast(`已新增「${r.name}」，但目前的篩選條件把它隱藏了`);
    })();
  },
});
$("btn-new-text").addEventListener("click", () => textEditor.openNew(S.dir));

// ---------------------------------------------------------------- keyboard

document.addEventListener("keydown", (ev) => {
  // 調整視窗開著時，按鍵全部交給它（包含焦點在滑桿上時的 Esc / Enter）
  if (editor.isOpen) {
    if (editor.key(ev)) ev.preventDefault();
    return;
  }
  if (textEditor.isOpen) return;
  const t = ev.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
  const mod = ev.ctrlKey || ev.metaKey;
  const k = ev.key;
  // 分頁：⌘1–9 切換、⌃Tab / ⌃⇧Tab 下一個 / 上一個、⌘T 新增、⌘W 關閉（macOS 由選單處理 ⌘T / ⌘W）
  if (mod && !ev.altKey && /^[1-9]$/.test(k) && tabs.length > 1) {
    ev.preventDefault();
    return void switchTab(Math.min(tabs.length, Number(k)) - 1);
  }
  if (ev.ctrlKey && k === "Tab" && tabs.length > 1) {
    ev.preventDefault();
    return void switchTab((activeTab + (ev.shiftKey ? tabs.length - 1 : 1)) % tabs.length);
  }
  if (mod && !ev.shiftKey && (k === "t" || k === "T") && !IS_MAC_UI) return ev.preventDefault(), void newTab();
  if (mod && !ev.shiftKey && (k === "w" || k === "W") && !IS_MAC_UI) return ev.preventDefault(), void closeTab(activeTab);

  // 對話框開著時，鍵盤只用來關閉它（不要誤評分背景的照片）
  if (!ctxMenu.classList.contains("hidden") && k === "Escape") return ev.preventDefault(), hideMenu();
  if (!settingsDialog.classList.contains("hidden")) {
    if (k === "Escape") settingsDialog.classList.add("hidden"), gridEl.focus();
    return;
  }
  if (exporter.isOpen) {
    if (k === "Escape") exporter.close();
    return;
  }
  if (batchRename.isOpen || !renameDialog.classList.contains("hidden") || !$("label-dialog").classList.contains("hidden")) {
    if (k === "Escape") {
      batchRename.close();
      renameDialog.classList.add("hidden");
      $("label-dialog").classList.add("hidden");
      gridEl.focus();
    }
    return;
  }
  if (k === "F2" && !S.loupe && !S.compare.length && !slideshow.active) return ev.preventDefault(), openRename();
  if (mod && ev.shiftKey && k.toLowerCase() === "r") return ev.preventDefault(), openBatchRename();
  if (mod && ev.shiftKey && k.toLowerCase() === "e") return ev.preventDefault(), openExport();
  if (mod && ev.shiftKey && k.toLowerCase() === "k") return ev.preventDefault(), void makeZip();
  if ((mod && !ev.shiftKey && k.toLowerCase() === "r") || k === "F5") return ev.preventDefault(), void refreshFolder();
  if (mod && ev.shiftKey && k.toLowerCase() === "g") return ev.preventDefault(), focusPath();

  if (!slideDialog.classList.contains("hidden")) {
    if (k === "Escape") closeSlideDialog();
    else if (k === "Enter") startSlideshow();
    else return;
    ev.preventDefault();
    return;
  }
  if (slideshow.active) {
    const lk = k.toLowerCase();
    const isRateKey = !mod && (/^[0-9]$/.test(k) || lk === "x");
    if (!isRateKey) {
      // 播放中：評分 / 標籤鍵交給下方共用處理，其他按鍵控制播放
      if (k === "Escape") slideshow.stop();
      else if (k === " ") slideshow.togglePause();
      else if (k === "ArrowRight" || k === "ArrowDown") slideshow.next();
      else if (k === "ArrowLeft" || k === "ArrowUp") slideshow.prev();
      else if (lk === "m") slideshow.toggleMute();
      else if (lk === "i") slideshow.toggleInfo();
      else if (lk === "f") slideshow.toggleFullscreen();
      ev.preventDefault();
      return;
    }
  }

  if (mod && k.toLowerCase() === "o") return ev.preventDefault(), void pickFolder();
  if (mod && k === "ArrowUp") {
    ev.preventDefault();
    if (S.parent) openFolder(S.parent);
    return;
  }
  // Mac 鍵盤的 delete 鍵送出的是 Backspace；Windows / 外接鍵盤則是 Delete
  if ((k === "Backspace" || k === "Delete") && !S.compare.length) {
    ev.preventDefault();
    // 選了縮圖區的資料夾：刪除資料夾
    if (S.folderSel && !S.loupe && !slideshow.active) void deleteFolder(S.folderSel);
    else void deleteTargets();
    return;
  }

  // 選了資料夾：評等 / 拒絕 / 標籤作用在資料夾上，Enter 開啟
  if (S.folderSel && !S.loupe && !S.compare.length && !slideshow.active) {
    if (!ev.altKey && /^[0-5]$/.test(k) && !mod) return ev.preventDefault(), void rateFolder(Number(k));
    if (k.toLowerCase() === "x" && !mod) return ev.preventDefault(), void rateFolder("toggle-reject");
    const fl = LABELS.find((l) => l.hotkey && l.hotkey === k);
    if (fl) return ev.preventDefault(), void labelFolder(fl.key);
    if (k === "Enter") return ev.preventDefault(), void openFolder(S.folderSel);
  }
  // 評等 / 拒絕 / 標籤（格狀、全螢幕、比較模式通用）
  if (!ev.altKey && /^[0-5]$/.test(k) && !mod) return ev.preventDefault(), void applyRating(Number(k));
  if (k.toLowerCase() === "x" && !mod) return ev.preventDefault(), void applyRating("toggle-reject");
  const lab = LABELS.find((l) => l.hotkey && l.hotkey === k);
  if (lab) return ev.preventDefault(), void applyLabel(lab.key);

  if (S.compare.length) {
    if (k === "Escape" || k.toLowerCase() === "c") closeCompare();
    else if (k === "ArrowRight" || k === "ArrowLeft") {
      const n = S.compare.length;
      S.compareActive = (S.compareActive + (k === "ArrowRight" ? 1 : n - 1)) % n;
      renderCompare(false);
    }
    ev.preventDefault();
    return;
  }

  if (S.loupe) {
    if (k === "Escape" || k === " " || k === "Enter") closeLoupe();
    else if (k === "ArrowRight" || k === "ArrowDown") moveFocus(1);
    else if (k === "ArrowLeft" || k === "ArrowUp") moveFocus(-1);
    else if (k.toLowerCase() === "z") toggleZoom();
    else if (k.toLowerCase() === "e" && !mod) openEditor();
    else if ((k === "[" || k === "]") && !mod) void rotateTargets(k === "]");
    else if (k.toLowerCase() === "f") {
      showFaces = !showFaces;
      store("showFaces", showFaces);
      renderFaces();
      toast(showFaces ? "顯示人臉框" : "隱藏人臉框", 1200);
    }
    else return;
    ev.preventDefault();
    return;
  }

  const cols = grid.columns;
  switch (k) {
    case "ArrowRight": moveFocus(1, ev.shiftKey); break;
    case "ArrowLeft": moveFocus(-1, ev.shiftKey); break;
    case "ArrowDown": moveFocus(cols, ev.shiftKey); break;
    case "ArrowUp": moveFocus(-cols, ev.shiftKey); break;
    case "Home": moveFocus(-Infinity, ev.shiftKey); break;
    case "End": moveFocus(Infinity, ev.shiftKey); break;
    case "PageDown": moveFocus(cols * Math.max(1, Math.floor(gridEl.clientHeight / 200)), ev.shiftKey); break;
    case "PageUp": moveFocus(-cols * Math.max(1, Math.floor(gridEl.clientHeight / 200)), ev.shiftKey); break;
    case " ":
    case "Enter": openLoupe(); break;
    case "+":
    case "=": bumpSize(20); break;
    case "-": bumpSize(-20); break;
    case "Escape":
      if (S.focus !== null) S.selected = new Set([S.focus]);
      grid.refresh();
      renderStatus();
      break;
    default:
      if (mod && k.toLowerCase() === "a") selectAll();
      else if (k.toLowerCase() === "c" && !mod) openCompare();
      else if (k.toLowerCase() === "p" && !mod) openSlideDialog();
      else if (k.toLowerCase() === "e" && !mod) openEditor();
      else if ((k === "[" || k === "]") && !mod) void rotateTargets(k === "]");
      else return;
  }
  ev.preventDefault();
});

// ---------------------------------------------------------------- 幻燈片

const slideshow = new Slideshow($("slideshow"), {
  previewUrl: (id) => url.preview(S.session, id),
  caption: (id) => {
    const m = S.meta.get(id);
    const lc = labelColor(m?.label);
    return (
      `<b>${escapeHtml(S.items[id].name)}</b>` +
      `<span class="stars${(m?.rating ?? 0) < 0 ? " rej" : ""}">${stars(m?.rating ?? 0)}</span>` +
      (lc ? `<span class="dot" style="background:${lc}"></span>` : "")
    );
  },
  onExit: (lastId) => {
    if (lastId !== null && S.viewIndex.has(lastId)) setFocus(lastId, false);
    gridEl.focus();
  },
});

const slideDialog = $("slide-dialog");
const slideSettings: SlideSettings = { ...DEFAULT_SETTINGS, ...storage<Partial<SlideSettings>>("slideshow", {}) };
const durations = new Map<string, number>();

function saveSlideSettings() {
  store("slideshow", slideSettings);
}

/** 重新允許上次選過的音樂（asset 協定的允許清單每次啟動都會重置），找不到的檔案移除 */
async function restoreMusic() {
  if (!slideSettings.music.length) return;
  const ok = await api
    .allowAudio(slideSettings.music)
    .then((r) => r.allowed)
    .catch(() => [] as string[]);
  if (ok.length !== slideSettings.music.length) {
    slideSettings.music = slideSettings.music.filter((p) => ok.includes(p));
    if (!slideSettings.music.length) slideSettings.fitMusic = false;
    saveSlideSettings();
  }
}

function slideCandidates(scope: "view" | "selected", skipRejected: boolean): number[] {
  let ids = S.view.map((i) => i.id);
  if (scope === "selected") ids = ids.filter((id) => S.selected.has(id));
  if (skipRejected) ids = ids.filter((id) => (S.meta.get(id)?.rating ?? 0) >= 0);
  return ids;
}

const ss = {
  scope: $<HTMLSelectElement>("ss-scope"),
  skip: $<HTMLInputElement>("ss-skip-rejected"),
  order: $<HTMLSelectElement>("ss-order"),
  start: $<HTMLSelectElement>("ss-start"),
  interval: $<HTMLInputElement>("ss-interval"),
  intervalV: $("ss-interval-v"),
  transition: $<HTMLSelectElement>("ss-transition"),
  loop: $<HTMLInputElement>("ss-loop"),
  fullscreen: $<HTMLInputElement>("ss-fullscreen"),
  info: $<HTMLInputElement>("ss-info"),
  music: $("ss-music"),
  volume: $<HTMLInputElement>("ss-volume"),
  fit: $<HTMLInputElement>("ss-fit"),
  summary: $("ss-summary"),
  go: $<HTMLButtonElement>("ss-go"),
};

function readSlideForm() {
  Object.assign(slideSettings, {
    scope: ss.scope.value as SlideSettings["scope"],
    skipRejected: ss.skip.checked,
    order: ss.order.value as SlideSettings["order"],
    start: ss.start.value as SlideSettings["start"],
    interval: Number(ss.interval.value),
    transition: ss.transition.value as SlideSettings["transition"],
    loop: ss.loop.checked,
    fullscreen: ss.fullscreen.checked,
    showInfo: ss.info.checked,
    volume: Number(ss.volume.value),
    fitMusic: ss.fit.checked && slideSettings.music.length > 0,
  });
  saveSlideSettings();
}

function renderSlideForm() {
  const st = slideSettings;
  const canSelected = S.selected.size >= 2;
  if (st.scope === "selected" && !canSelected) st.scope = "view";
  ss.scope.value = st.scope;
  ss.scope.querySelector<HTMLOptionElement>('[value="selected"]')!.disabled = !canSelected;
  ss.skip.checked = st.skipRejected;
  ss.order.value = st.order;
  ss.start.value = st.start;
  ss.interval.value = String(st.interval);
  ss.transition.value = st.transition;
  ss.loop.checked = st.loop;
  ss.fullscreen.checked = st.fullscreen;
  ss.info.checked = st.showInfo;
  ss.volume.value = String(st.volume);
  ss.fit.checked = st.fitMusic;
  ss.fit.disabled = !st.music.length;
  ss.music.innerHTML = st.music.length
    ? st.music
        .map(
          (p, i) => {
            const err = !durations.has(p) ? audioErrors.get(p) : undefined;
            const playing = previewing === p;
            return `<li title="${escapeHtml(p)}"${err ? ' class="bad"' : ""}>
          <button data-play="${i}" title="${playing ? "停止試聽" : "試聽"}">${playing ? "■" : "▶"}</button>
          <span class="t">${escapeHtml(fileName(p))}${err ? `<small>⚠ ${escapeHtml(err)}</small>` : ""}</span>
          <span class="d">${durations.has(p) ? fmtTime(durations.get(p)!) : err ? "" : "讀取中…"}</span>
          <button data-up="${i}" title="往前移">↑</button><button data-del="${i}" title="移除">✕</button></li>`;
          },
        )
        .join("")
    : `<li class="music-empty">尚未選擇音樂（不加音樂也可以，會安靜播放）</li>`;
  updateSlideSummary();
}

function updateSlideSummary() {
  const n = slideCandidates(ss.scope.value as SlideSettings["scope"], ss.skip.checked).length;
  const total = slideSettings.music.reduce((a, p) => a + (durations.get(p) ?? 0), 0);
  const fit = ss.fit.checked && total > 0 && n > 0;
  const per = fit ? Math.min(30, Math.max(2, total / n)) : Number(ss.interval.value);
  ss.interval.disabled = fit;
  ss.intervalV.textContent = `${per.toFixed(1)} 秒${fit ? "（依音樂）" : ""}`;
  let note = "";
  if (fit && total / n < 2) note = "（音樂較短，會重複播放）";
  else if (fit && total / n > 30) note = "（音樂較長，照片播完會淡出）";
  ss.summary.textContent = n
    ? `共 ${n} 張，約 ${fmtTime(n * per)}${total ? `；音樂 ${fmtTime(total)}` : ""}${note}`
    : "沒有可播放的照片";
  ss.go.disabled = !n;
}

async function loadDurations() {
  for (const p of slideSettings.music) {
    if (!durations.has(p)) {
      const d = await audioDuration(p);
      if (isFinite(d)) durations.set(p, d);
    }
  }
  if (!slideDialog.classList.contains("hidden")) renderSlideForm();
}

function openSlideDialog() {
  if (!S.items.length) return toast("請先開啟照片資料夾");
  if (S.loupe) closeLoupe();
  if (S.compare.length) closeCompare();
  renderSlideForm();
  slideDialog.classList.remove("hidden");
  ss.go.focus();
  loadDurations();
}

// 試聽：用和幻燈片相同的方式讀取與播放，確認音樂可以正常出聲
const previewAudio = new Audio();
let previewing: string | null = null;
let previewTimer = 0;

function stopPreview() {
  clearTimeout(previewTimer);
  previewAudio.pause();
  previewAudio.removeAttribute("src");
  if (previewing !== null) {
    previewing = null;
    if (!slideDialog.classList.contains("hidden")) renderSlideForm();
  }
}

async function togglePreview(path: string) {
  if (previewing === path) return stopPreview();
  stopPreview();
  previewing = path;
  renderSlideForm();
  try {
    previewAudio.src = await audioSrc(path);
    if (previewing !== path) return;
    previewAudio.volume = Number(ss.volume.value);
    await previewAudio.play();
    audioErrors.delete(path);
    previewTimer = window.setTimeout(stopPreview, 15000);
  } catch (e) {
    const err = e as { name?: string; message?: string };
    audioErrors.set(
      path,
      previewAudio.error ? mediaErrorText(previewAudio.error) : err?.name === "NotAllowedError" ? "系統不允許播放" : String(err?.message ?? e),
    );
    durations.delete(path);
    previewing = null;
    renderSlideForm();
  }
}
previewAudio.addEventListener("error", () => {
  if (!previewing) return;
  audioErrors.set(previewing, mediaErrorText(previewAudio.error));
  durations.delete(previewing);
  previewing = null;
  renderSlideForm();
});
previewAudio.addEventListener("ended", stopPreview);

function closeSlideDialog() {
  stopPreview();
  slideDialog.classList.add("hidden");
  gridEl.focus();
}

async function startSlideshow() {
  readSlideForm();
  const ids = slideCandidates(slideSettings.scope, slideSettings.skipRejected);
  if (!ids.length) return;
  stopPreview();
  // 在使用者按下「開始播放」的當下就讓音樂開始（避免被系統的自動播放限制擋下）
  slideshow.primeAudio(slideSettings.music);
  const startIdx = slideSettings.start === "focus" && S.focus !== null ? Math.max(0, ids.indexOf(S.focus)) : 0;
  slideDialog.classList.add("hidden");
  await slideshow.start(ids, slideSettings, startIdx);
}

slideDialog.addEventListener("input", () => {
  previewAudio.volume = Number(ss.volume.value);
  readSlideForm();
  updateSlideSummary();
});
slideDialog.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t === slideDialog) return closeSlideDialog(); // 點背景關閉
  const play = t.getAttribute("data-play");
  if (play !== null) return void togglePreview(slideSettings.music[Number(play)]);
  const del = t.getAttribute("data-del");
  const up = t.getAttribute("data-up");
  if (del !== null) {
    if (previewing === slideSettings.music[Number(del)]) stopPreview();
    slideSettings.music.splice(Number(del), 1);
  } else if (up !== null && Number(up) > 0) {
    const i = Number(up);
    [slideSettings.music[i - 1], slideSettings.music[i]] = [slideSettings.music[i], slideSettings.music[i - 1]];
  } else return;
  if (!slideSettings.music.length) slideSettings.fitMusic = false;
  saveSlideSettings();
  renderSlideForm();
});
$("ss-add-music").addEventListener("click", async () => {
  const picked = await openDialog({
    multiple: true,
    title: "選擇背景音樂",
    filters: [{ name: "音樂", extensions: ["mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "opus"] }],
  });
  const list = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  if (!list.length) return;
  const { allowed: ok, rejected } = await api.allowAudio(list);
  if (rejected.length)
    toast(`${rejected.length} 個檔案無法加入：` + rejected.map(([p, r]) => `${fileName(p)}（${r}）`).join("、"), 6000);
  slideSettings.music.push(...ok.filter((p) => !slideSettings.music.includes(p)));
  saveSlideSettings();
  renderSlideForm();
  loadDurations();
});
$("ss-cancel").addEventListener("click", closeSlideDialog);
$("ss-go").addEventListener("click", startSlideshow);
$("btn-slideshow").addEventListener("click", openSlideDialog);

// ---------------------------------------------------------------- macOS

const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes("Mac OS X");

/** Mac 上把介面中的 Ctrl 提示改成 ⌘ */
function applyMacLabels() {
  if (!isMac) return;
  document.querySelectorAll("kbd").forEach((k) => {
    if (k.textContent === "Ctrl") k.textContent = "⌘";
  });
  document.querySelectorAll<HTMLElement>("[title]").forEach((el) => {
    el.title = el.title.replace(/Ctrl\+/g, "⌘");
  });
}

function selectAll() {
  S.selected = new Set(S.view.map((i) => i.id));
  grid.refresh();
  renderStatus();
}

/** macOS 選單列的指令（Rust 端以 "menu" 事件送來） */
on<string>("menu", (e) => {
  switch (e.payload) {
    case "open":
      pickFolder();
      break;
    case "up":
      if (S.parent) openFolder(S.parent);
      break;
    case "website":
      api.openWebsite().catch((e) => toast(`無法開啟網站：${e}`));
      break;
    case "crop":
      api.openLink("crop").catch((e) => toast(`無法開啟「照片裁切輸出」：${e}`));
      break;
    case "batch-rename":
      openBatchRename();
      break;
    case "export":
      openExport();
      break;
    case "zip":
      void makeZip();
      break;
    case "edit":
      openEditor();
      break;
    case "goto":
      focusPath();
      break;
    case "refresh":
      void refreshFolder();
      break;
    case "new-tab":
      void newTab();
      break;
    case "close-tab":
      void closeTab(activeTab);
      break;
    case "next-tab":
      if (tabs.length > 1) void switchTab((activeTab + 1) % tabs.length);
      break;
    case "prev-tab":
      if (tabs.length > 1) void switchTab((activeTab - 1 + tabs.length) % tabs.length);
      break;
    case "rethumb":
      void regenerateThumbs();
      break;
    case "slideshow":
      if (!slideshow.active) openSlideDialog();
      break;
    case "select-all":
      if (!S.loupe && !S.compare.length) selectAll();
      break;
  }
});

// ---------------------------------------------------------------- 圖片診斷

onImageDiag((msg, isError) => {
  const el = $("diag");
  el.textContent = msg;
  el.classList.toggle("err", isError);
  el.title = msg;
  if (!isError) toast(msg, 4000);
});

// ---------------------------------------------------------------- 路徑列（可輸入 / 貼上路徑）

const pathInput = $<HTMLInputElement>("path");

function focusPath() {
  pathInput.focus();
  pathInput.select();
}

async function gotoPath() {
  const text = pathInput.value;
  if (!text.trim() || text.trim() === S.dir) return gridEl.focus();
  if (!(await openPath(text))) pathInput.select();
}

/** 開啟一個路徑：資料夾 → 開啟；照片檔 → 開啟所在資料夾並選取那張。成功回傳 true */
async function openPath(text: string): Promise<boolean> {
  try {
    const r = await api.resolvePath(text);
    await openFolder(r.dir);
    if (r.file) {
      const want = r.file.toLowerCase();
      const base = (p: string) => (p.split(/[\\/]/).pop() ?? p).toLowerCase();
      const it = S.items.find((i) => i.files.some((f) => f.toLowerCase() === want || base(f) === want));
      if (it && S.viewIndex.has(it.id)) setFocus(it.id, false);
    }
    gridEl.focus();
    return true;
  } catch (e) {
    toast(String(e), 4000);
    return false;
  }
}

// ---------------------------------------------------------------- 從 Finder 拖資料夾 / 照片進來

{
  const overlay = $("drop-overlay");
  let lastOwnDrag = 0;
  // 自己的拖曳：拖曳進行中，或放下的檔案正是剛剛拖出去的那些（有些系統 startDrag 會提早結束）
  const own = (paths?: string[]) =>
    dragging ||
    Date.now() - lastOwnDrag < 1500 ||
    (!!paths?.length && Date.now() - dragAt < 120000 && paths.every((x) => dragFiles.has(x)));
  // 自己的縮圖拖出去又放回視窗時不要當成「開啟」
  setInterval(() => {
    if (dragging) lastOwnDrag = Date.now();
  }, 200);
  let ownDrop = false;
  void getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload;
    // 自己的縮圖拖到分頁上：反白那個分頁；放下 = 複製 / 移動到那個分頁的資料夾
    const ps = "paths" in p ? (p as { paths: string[] }).paths : undefined;
    if (p.type === "enter" || p.type === "drop") ownDrop = own(ps);
    if (ownDrop && tabs.length > 1) {
      if (p.type === "over" || p.type === "enter") markDropTab(tabAt(p.position));
      else if (p.type === "leave") markDropTab(-1);
      else if (p.type === "drop") {
        markDropTab(-1);
        ownDrop = false;
        const i = tabAt(p.position);
        if (i >= 0) dropOnTab(i, dragIds);
      }
      return;
    }
    if (ownDrop && (p.type === "over" || p.type === "leave")) return;
    if (p.type === "enter") {
      if (ownDrop || !p.paths.length) return;
      $("drop-text").textContent = p.paths.length > 1 ? `放開以分頁開啟這 ${p.paths.length} 個資料夾` : "放開以開啟這個資料夾";
      overlay.classList.remove("hidden");
    } else if (p.type === "leave") {
      overlay.classList.add("hidden");
    } else if (p.type === "drop") {
      overlay.classList.add("hidden");
      if (ownDrop || !p.paths.length) {
        ownDrop = false;
        return;
      }
      if (editor.isOpen || slideshow.active) return toast("請先關閉調整視窗或幻燈片，再拖入資料夾");
      if (S.loupe) closeLoupe();
      void (async () => {
        // 拖入多個資料夾：第一個在目前分頁開啟，其他各開一個新分頁
        if (!(await openPath(p.paths[0]))) return;
        for (const extra of p.paths.slice(1)) {
          try {
            const r = await api.resolvePath(extra);
            await newTab(r.dir);
          } catch {
            /* 不是資料夾或無法讀取：略過 */
          }
        }
      })();
    }
  });
}

pathInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    void gotoPath();
  } else if (ev.key === "Escape") {
    pathInput.value = S.dir;
    gridEl.focus();
  }
});
pathInput.addEventListener("focus", () => setTimeout(() => pathInput.select(), 0));
pathInput.addEventListener("blur", () => {
  pathInput.value = S.dir;
  pathInput.scrollLeft = pathInput.scrollWidth;
});

/** 重新讀取目前資料夾，維持捲動位置，並選取指定名稱的照片 */
async function reloadFolder(focusName?: string | null) {
  const top = gridEl.scrollTop;
  const prevIdx = S.focus !== null ? (S.viewIndex.get(S.focus) ?? 0) : 0;
  await openFolder(S.dir);
  gridEl.scrollTop = top;
  const it = focusName ? S.items.find((i) => i.name === focusName) : S.view[Math.min(prevIdx, S.view.length - 1)];
  if (it && S.viewIndex.has(it.id)) setFocus(it.id, false);
}

// ---------------------------------------------------------------- 右鍵選單

const ctxMenu = $("ctx-menu");

function hideMenu() {
  ctxMenu.classList.add("hidden");
}

function showCellMenu(index: number, ev: MouseEvent) {
  const it = S.view[index];
  if (!it) return;
  if (!S.selected.has(it.id)) setFocus(it.id, false);
  else S.focus = it.id;
  const n = S.selected.size;
  const isMac = /Mac/.test(navigator.platform) || navigator.userAgent.includes("Mac OS X");
  const items: [string, string, string?][] = [
    ...(it.kind === "text" ? ([["textedit", "編輯文字…"], ["-", ""]] as [string, string][]) : []),
    ["reveal", isMac ? "在 Finder 中顯示" : "在檔案總管中顯示"],
    ["rename", "重新命名…", "F2"],
    ["batch", n > 1 ? `批次重新命名 ${n} 張…` : "批次重新命名…", "⇧⌘R"],
    ["rotl", n > 1 ? `逆時針旋轉 ${n} 張` : "逆時針旋轉 90°", "["],
    ["rotr", n > 1 ? `順時針旋轉 ${n} 張` : "順時針旋轉 90°", "]"],
    ["edit", n > 1 ? `調整 ${n} 張照片…` : "調整照片…", "E"],
    ["zip", n > 1 ? `壓縮打包 ${n} 張…` : "壓縮打包…", "⇧⌘K"],
    ["rethumb", n > 1 ? `重新產生 ${n} 張縮圖` : "重新產生縮圖"],
    ["export", n > 1 ? `影像轉存 ${n} 張…` : "影像轉存…", "⇧⌘E"],
    ["-", ""],
    ["copy", n > 1 ? `複製 ${n} 張到…` : "複製到…"],
    ["move", n > 1 ? `移動 ${n} 張到…` : "移動到…"],
    ["-", ""],
    ["trash", n > 1 ? `將 ${n} 張移到垃圾桶` : "移到垃圾桶", "⌫"],
  ];
  ctxMenu.innerHTML = items
    .map(([a, label, key]) =>
      a === "-" ? `<div class="sep"></div>` : `<div class="item${a === "trash" ? " danger" : ""}" data-a="${a}"><span>${label}</span><kbd>${key ?? ""}</kbd></div>`,
    )
    .join("");
  ctxMenu.classList.remove("hidden");
  const w = ctxMenu.offsetWidth;
  const h = ctxMenu.offsetHeight;
  ctxMenu.style.left = `${Math.min(ev.clientX, innerWidth - w - 6)}px`;
  ctxMenu.style.top = `${Math.min(ev.clientY, innerHeight - h - 6)}px`;
}

ctxMenu.addEventListener("click", (ev) => {
  const a = (ev.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
  hideMenu();
  if (a?.startsWith("f-")) {
    const p = ctxFolder;
    if (a === "f-open") void openFolder(p);
    else if (a === "f-tab") void newTab(p);
    else if (a === "f-reveal") api.openDir(p).catch((e) => toast(`無法開啟：${e}`));
    else if (a === "f-new") void newFolder();
    else if (a === "f-trash") void deleteFolder(p);
    return;
  }
  if (!a || S.focus === null) return;
  if (a === "textedit") void textEditor.openEdit(S.session, S.focus);
  else if (a === "reveal") api.revealItem(S.session, S.focus).catch((e) => toast(`無法開啟：${e}`));
  else if (a === "rename") openRename();
  else if (a === "batch") openBatchRename();
  else if (a === "export") openExport();
  else if (a === "rethumb") void regenerateThumbs();
  else if (a === "edit") openEditor();
  else if (a === "rotl") void rotateTargets(false);
  else if (a === "rotr") void rotateTargets(true);
  else if (a === "zip") void makeZip();
  else if (a === "copy") void transfer("copy");
  else if (a === "move") void transfer("move");
  else if (a === "trash") void deleteTargets();
});
document.addEventListener("mousedown", (ev) => {
  if (!ctxMenu.contains(ev.target as Node)) hideMenu();
});
gridEl.addEventListener("scroll", hideMenu, { passive: true });
window.addEventListener("blur", hideMenu);

// ---------------------------------------------------------------- 資料夾：新增、右鍵選單、拖到分頁列開新分頁

let ctxFolder = "";

function showFolderMenu(path: string, ev: MouseEvent) {
  ctxFolder = path;
  const isMac = /Mac/.test(navigator.platform) || navigator.userAgent.includes("Mac OS X");
  const items: [string, string][] = [
    ["f-open", "開啟"],
    ["f-tab", "在新分頁開啟"],
    ["f-reveal", isMac ? "在 Finder 中開啟" : "在檔案總管中開啟"],
    ["-", ""],
    ["f-new", "新增資料夾…"],
    ["-", ""],
    ["f-trash", "移到垃圾桶"],
  ];
  ctxMenu.innerHTML = items
    .map(([a, label]) =>
      a === "-"
        ? `<div class="sep"></div>`
        : `<div class="item${a === "f-trash" ? " danger" : ""}" data-a="${a}"><span>${label}</span><kbd>${a === "f-trash" ? "⌫" : ""}</kbd></div>`,
    )
    .join("");
  ctxMenu.classList.remove("hidden");
  ctxMenu.style.left = `${Math.min(ev.clientX, innerWidth - ctxMenu.offsetWidth - 6)}px`;
  ctxMenu.style.top = `${Math.min(ev.clientY, innerHeight - ctxMenu.offsetHeight - 6)}px`;
}

/** 把資料夾（連同裡面的檔案）移到垃圾桶；確認方式與刪除照片相同 */
let deletingFolder = false;
async function deleteFolder(path: string) {
  const d = S.subdirs.find((x) => x.path === path);
  if (!d || deletingFolder) return;
  if (confirmDelete.checked) {
    const ok = await ask(`把資料夾「${d.name}」連同裡面所有的檔案移到垃圾桶？\n需要時可以從垃圾桶復原。`, {
      title: "刪除資料夾",
      kind: "warning",
      okLabel: "移到垃圾桶",
      cancelLabel: "取消",
    });
    if (!ok) return;
  }
  deletingFolder = true;
  try {
    await api.trashFolder(path);
    S.subdirs = S.subdirs.filter((x) => x.path !== path);
    // 其他分頁開著這個資料夾（或它裡面的資料夾）：改成顯示目前這個資料夾（被刪資料夾的上一層）
    const inside = (p: string) => p === path || p.startsWith(path.endsWith("/") || path.endsWith("\\") ? path : path + (path.includes("\\") && !path.includes("/") ? "\\" : "/"));
    let moved = 0;
    tabs.forEach((t, i) => {
      if (i !== activeTab && inside(t.dir)) {
        tabs[i] = { dir: S.dir, sort: t.sort, sortDesc: t.sortDesc };
        moved++;
      }
    });
    if (moved) {
      saveTabs();
      renderTabs();
    }
    update();
    void folderTree.refresh();
    toast(`已將資料夾「${d.name}」移到垃圾桶`, 2000);
  } catch (e) {
    toast(`無法刪除資料夾「${d.name}」：${e}`, 8000);
  } finally {
    deletingFolder = false;
    gridEl.focus();
  }
}

/** 輸入名稱的小對話框；submit 回傳錯誤訊息時保持開啟並顯示錯誤 */
function askName(title: string, value: string, submit: (name: string) => Promise<string | null>) {
  const box = document.createElement("div");
  box.className = "modal";
  box.innerHTML = `<div class="modal-box name-box"><h2>${escapeHtml(title)}</h2>
    <input type="text" spellcheck="false" autocomplete="off" />
    <div class="name-err"></div>
    <div class="modal-actions"><span></span><button data-a="cancel">取消</button><button data-a="ok" class="primary">建立</button></div></div>`;
  document.body.appendChild(box);
  const input = box.querySelector("input")!;
  const err = box.querySelector<HTMLElement>(".name-err")!;
  input.value = value;
  const close = () => {
    box.remove();
    gridEl.focus();
  };
  let busy = false;
  const ok = async () => {
    if (busy) return;
    busy = true;
    const e = await submit(input.value.trim());
    busy = false;
    if (e) {
      err.textContent = e;
      input.focus();
    } else close();
  };
  box.querySelector('[data-a="cancel"]')!.addEventListener("click", close);
  box.querySelector('[data-a="ok"]')!.addEventListener("click", () => void ok());
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") ev.preventDefault(), void ok();
    else if (ev.key === "Escape") ev.preventDefault(), close();
  });
  input.focus();
  input.select();
}

function newFolder() {
  if (!S.dir) return toast("請先開啟一個資料夾");
  askName("在目前的資料夾新增資料夾", "未命名資料夾", async (name) => {
    try {
      const path = await api.createFolder(S.dir, name);
      await doRefreshFolder(true);
      void folderTree.refresh();
      grid.highlightFolder(path);
      toast(`已新增資料夾「${name}」`);
      return null;
    } catch (e) {
      return String(e);
    }
  });
}
$("btn-new-folder").addEventListener("click", () => newFolder());

/** 按住資料夾拖曳：放到分頁列（「＋」）上就用新分頁開啟 */
function startFolderDrag(path: string, name: string, down: MouseEvent) {
  let ghost: HTMLDivElement | null = null;
  let overTabs = false;
  const plus = () => document.getElementById("tab-new");
  const move = (ev: MouseEvent) => {
    if (!ghost) {
      if ((ev.buttons & 1) === 0) return up(ev);
      if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 6) return;
      ghost = document.createElement("div");
      ghost.className = "folder-ghost";
      ghost.innerHTML = `<span>📁</span> ${escapeHtml(name)}<small>拖到上方「＋」開新分頁</small>`;
      document.body.appendChild(ghost);
      document.body.classList.add("folder-dragging");
    }
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    overTabs = !!el?.closest("#tabbar");
    plus()?.classList.toggle("drop-target", overTabs);
  };
  const up = (ev: MouseEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up, true);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("folder-dragging");
    plus()?.classList.remove("drop-target");
    // 拖曳結束後的 click 不要當成「點資料夾」
    const swallow = (e: MouseEvent) => (e.stopPropagation(), e.preventDefault());
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    if (overTabs || el?.closest("#tabbar")) void newTab(path);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up, true);
}

// ---------------------------------------------------------------- 重新命名（單張）

const renameDialog = $("rename-dialog");
const renameInput = $<HTMLInputElement>("rename-input");
let renameId: number | null = null;

function openRename() {
  if (S.focus === null) return;
  const it = S.items[S.focus];
  renameId = it.id;
  // 文字檔的名稱含副檔名：只改主檔名
  renameInput.value = it.kind === "text" ? it.name.replace(/\.[^.]+$/, "") : it.name;
  $("rename-files").textContent = `會一起改名：${it.files.join("、")}（以及 .xmp 附屬檔，副檔名不變）`;
  $("rename-error").textContent = "";
  renameDialog.classList.remove("hidden");
  renameInput.focus();
  renameInput.select();
}

async function doRename() {
  if (renameId === null) return;
  const stem = renameInput.value.trim().replace(/[/:]/g, "-");
  if (!stem) return;
  const cur = S.items[renameId];
  const ext = cur.kind === "text" ? (cur.name.match(/\.[^.]+$/)?.[0] ?? "") : "";
  if (stem + ext === cur.name) {
    renameDialog.classList.add("hidden");
    return gridEl.focus();
  }
  const r = await api.batchRename(S.session, [{ id: renameId, stem }], "rename", null, false).catch((e) => ({
    done: 0,
    failed: [String(e)],
  }));
  if (r.failed.length) {
    $("rename-error").textContent = r.failed.join("；");
    return;
  }
  renameDialog.classList.add("hidden");
  await reloadFolder(stem + ext);
  gridEl.focus();
}

renameInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    void doRename();
  } else if (ev.key === "Escape") {
    renameDialog.classList.add("hidden");
    gridEl.focus();
  }
});
$("rename-ok").addEventListener("click", () => void doRename());
$("rename-cancel").addEventListener("click", () => {
  renameDialog.classList.add("hidden");
  gridEl.focus();
});

// ---------------------------------------------------------------- 批次重新命名

const batchRename = new BatchRename($("batch-rename"), {
  session: () => S.session,
  targets: (scope) => (scope === "selected" ? S.view.filter((i) => S.selected.has(i.id)) : S.view),
  selectedCount: () => S.selected.size,
  viewCount: () => S.view.length,
  meta: (id) => S.meta.get(id),
  run: (entries, s) => api.batchRename(S.session, entries, s.dest, s.dest === "rename" ? null : s.destDir, s.preserve, renameBake.checked),
  done: async (s, firstNewName) => {
    if (s.dest === "copy") {
      notify(`已重新命名並拷貝到「${folderName(s.destDir)}」`, openDirAction(s.destDir));
      return;
    }
    await reloadFolder(s.dest === "rename" ? firstNewName : null);
    if (s.dest === "move") notify(`已重新命名並移到「${folderName(s.destDir)}」`, openDirAction(s.destDir));
    else toast("重新命名完成");
  },
});

function openBatchRename() {
  if (!S.items.length) return toast("請先開啟照片資料夾");
  if (S.loupe) closeLoupe();
  batchRename.open();
}
$("btn-batch-rename").addEventListener("click", openBatchRename);

// ---------------------------------------------------------------- 照片調整

const editor = new Editor($("editor"), {
  session: () => S.session,
  toast: (m) => toast(m, 6000),
  focus: (id) => {
    if (S.viewIndex.has(id) && S.focus !== id) {
      S.focus = id;
      S.anchor = id;
      if (!S.selected.has(id)) S.selected = new Set([id]);
      grid.scrollToIndex(S.viewIndex.get(id)!);
      grid.render();
      grid.refresh();
      renderStatus();
    }
  },
  saved: (results) => {
    for (const [id, edited] of results) {
      const m = S.meta.get(id);
      if (m) m.edited = edited;
    }
    grid.reloadThumbs(new Set(results.map(([id]) => id)));
    grid.refresh();
    renderFilters();
  },
  closed: () => {
    // 關閉時重新套用篩選（例如正在看「已調整」，剛重設的照片要離開清單）
    update();
    grid.refreshViewport();
    gridEl.focus();
  },
});

/** 調整：選取多張時逐張調整選取的照片，否則可在目前顯示的所有照片間切換 */
function openEditor() {
  if (S.focus === null || slideshow.active || S.compare.length) return;
  // 只把選取的照片帶進調整視窗；只選一張（或沒選）時就只開焦點那一張
  const sel = S.view.filter((it) => S.selected.has(it.id));
  const focusItem = S.view.find((it) => it.id === S.focus);
  const list = (sel.length > 1 ? sel : focusItem ? [focusItem] : []).filter((it) => it.kind !== "text");
  if (!list.length) {
    if (focusItem?.kind === "text") toast("文字檔不能調整；按兩下文字檔可以編輯內容");
    return;
  }
  // 從第一張開始
  const start = 0;
  const wasLoupe = S.loupe;
  if (wasLoupe) closeLoupe();
  void editor.open(list, start);
}
$("btn-edit").addEventListener("click", openEditor);

// ---------------------------------------------------------------- 旋轉（[ 逆時針、] 順時針）

let rotating = Promise.resolve();

/** 旋轉焦點 / 選取的照片 90°，結果存回原檔，縮圖跟著更新（連按會依序處理） */
function rotateTargets(clockwise: boolean) {
  const ids: number[] = targets().filter((id) => S.items[id]?.kind !== "text");
  if (!ids.length) return;
  rotating = rotating.then(async () => {
    try {
      const r = await api.rotate(S.session, ids, clockwise);
      for (const [id, o] of r.done) {
        const m = S.meta.get(id);
        // 寬高對調（狀態列的長 × 寬）
        if (m && m.width && m.height) [m.width, m.height] = [m.height, m.width];
        void o;
      }
      for (const k of [...fileInfoCache.keys()]) if (ids.some((id) => k === `${S.session}:${id}`)) fileInfoCache.delete(k);
      grid.reloadThumbs(new Set(ids));
      if (S.loupe) showLoupe();
      renderStatus();
      if (r.failed.length) toast(`有 ${r.failed.length} 張無法旋轉：${r.failed[0]}`, 8000);
    } catch (e) {
      toast(`無法旋轉：${e}`);
    }
  });
}

// ---------------------------------------------------------------- 壓縮打包

let zipping = false;
on<{ done: number; total: number }>("zip-progress", (e) => {
  if (zipping) toast(`正在準備照片 ${e.payload.done} / ${e.payload.total}…`, 60000);
});

async function makeZip() {
  if (zipping) return toast("正在壓縮打包中，請稍候");
  const ids = S.view.filter((it) => S.selected.has(it.id)).map((it) => it.id);
  if (!ids.length) return toast("請先選取要打包的照片");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${folderName(S.dir) || "照片"}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.zip`;
  const sep = S.dir.includes("\\") ? "\\" : "/";
  let dest = await saveDialog({ title: `壓縮打包 ${ids.length} 張照片`, defaultPath: S.dir ? `${S.dir}${sep}${base}` : base, filters: [{ name: "ZIP 壓縮檔", extensions: ["zip"] }] });
  if (!dest) return;
  if (!/\.zip$/i.test(dest)) dest += ".zip";
  zipping = true;
  toast(`正在壓縮打包 ${ids.length} 張照片…`, 60000);
  try {
    const r = await api.makeZip(S.session, ids, dest, zipRaw.checked, zipBake.checked);
    const parent = dest.replace(/[\\/][^\\/]*$/, "");
    notify(
      `已打包 ${r.done} 張到「${fileName(dest)}」${r.failed.length ? `，${r.failed.length} 張失敗` : ""}`,
      openDirAction(parent),
      r.failed.length ? 10000 : undefined,
    );
    if (r.failed.length) console.warn(r.failed);
  } catch (e) {
    toast(`壓縮打包失敗：${e}`, 10000);
  } finally {
    zipping = false;
  }
}
$("btn-zip").addEventListener("click", () => void makeZip());

// ---------------------------------------------------------------- 影像轉存

const exporter = new Exporter($("export-dialog"), {
  session: () => S.session,
  selectedIds: () => S.view.filter((it) => S.selected.has(it.id) && it.kind !== "text").map((it) => it.id),
  currentDir: () => S.dir,
  toast: (m) => toast(m),
  done: (r) => {
    const dir = r.dirs[0];
    const more = r.dirs.length > 1 ? `（共 ${r.dirs.length} 個資料夾）` : dir ? `到「${folderName(dir)}」` : "";
    notify(
      `已轉存 ${r.done} 張${more}${r.failed.length ? `，${r.failed.length} 張失敗` : ""}`,
      dir ? openDirAction(dir) : undefined,
      r.failed.length ? Math.max(8000, toastSeconds() * 1000) : undefined,
    );
    if (r.failed.length) {
      console.warn(r.failed);
      if (!r.failed.every((f) => f.endsWith("已取消"))) toast(`轉存失敗：${r.failed.slice(0, 3).join("；")}`, 10000);
    }
  },
});

function openExport() {
  if (S.loupe || S.compare.length || slideshow.active) return;
  exporter.open();
}
$("btn-export").addEventListener("click", openExport);

// ---------------------------------------------------------------- 系統設定

const settingsDialog = $("settings-dialog");
$("btn-settings").addEventListener("click", () => settingsDialog.classList.remove("hidden"));
$("settings-close").addEventListener("click", () => {
  settingsDialog.classList.add("hidden");
  gridEl.focus();
});
settingsDialog.addEventListener("mousedown", (e) => {
  if (e.target === settingsDialog) settingsDialog.classList.add("hidden");
});

// ---------------------------------------------------------------- 標籤名稱設定（與 Bridge 一致）

const labelDialog = $("label-dialog");

function renderLabelDialog(names: LabelNames) {
  $("label-fields").innerHTML = LABELS.map(
    (l) => `<label><span class="dot" style="background:${l.color}"></span><span class="zh">${l.zh}${l.hotkey ? `（${l.hotkey}）` : ""}</span>
      <input type="text" data-key="${l.key}" value="${escapeHtml(names[l.key])}" spellcheck="false" /></label>`,
  ).join("");
  const preset = LABEL_PRESETS.find((p) => LABELS.every((l) => p.names[l.key] === names[l.key]));
  $<HTMLSelectElement>("label-preset").value = preset ? preset.id : "custom";
}

function readLabelDialog(): LabelNames {
  const n = getLabelNames();
  labelDialog.querySelectorAll<HTMLInputElement>("input[data-key]").forEach((i) => {
    const v = i.value.trim();
    if (v) n[i.dataset.key as LabelKey] = v;
  });
  return n;
}

$<HTMLSelectElement>("label-preset").innerHTML =
  LABEL_PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("") +
  `<option value="custom">自訂</option>`;
$("label-preset").addEventListener("change", (e) => {
  const p = LABEL_PRESETS.find((x) => x.id === (e.target as HTMLSelectElement).value);
  if (p) renderLabelDialog(p.names);
});
labelDialog.addEventListener("input", (e) => {
  if ((e.target as HTMLElement).dataset.key) {
    const n = readLabelDialog();
    const preset = LABEL_PRESETS.find((p) => LABELS.every((l) => p.names[l.key] === n[l.key]));
    $<HTMLSelectElement>("label-preset").value = preset ? preset.id : "custom";
  }
});
$("btn-label-names").addEventListener("click", () => {
  settingsDialog.classList.add("hidden");
  renderLabelDialog(getLabelNames());
  labelDialog.classList.remove("hidden");
});
$("label-cancel").addEventListener("click", () => labelDialog.classList.add("hidden"));
$("label-save").addEventListener("click", () => {
  setLabelNames(readLabelDialog());
  labelDialog.classList.add("hidden");
  update();
  toast("已儲存標籤名稱。之後加上的標籤會使用新名稱");
});

// ---------------------------------------------------------------- 品牌連結、提示秒數設定

$("brand").addEventListener("click", () => api.openWebsite().catch((e) => toast(`無法開啟網站：${e}`)));
$("btn-crop").addEventListener("click", () => api.openLink("crop").catch((e) => toast(`無法開啟「照片裁切輸出」：${e}`)));
{
  const inp = $<HTMLInputElement>("toast-seconds");
  inp.value = String(toastSeconds());
  inp.addEventListener("change", () => {
    const v = Math.round(Number(inp.value));
    const sec = Number.isFinite(v) && v >= 1 ? Math.min(60, v) : 4;
    inp.value = String(sec);
    store("toastSeconds", sec);
  });
}

// ---------------------------------------------------------------- 側欄寬度

const SIDE_DEFAULT = 240;
function setSideWidth(px: number) {
  const w = Math.max(170, Math.min(520, Math.round(px)));
  document.documentElement.style.setProperty("--side-w", `${w}px`);
  return w;
}
setSideWidth(storage("sideWidth", SIDE_DEFAULT));
{
  const handle = $("side-resizer");
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add("drag");
    document.body.classList.add("resizing");
    const move = (e: PointerEvent) => setSideWidth(e.clientX);
    const up = (e: PointerEvent) => {
      store("sideWidth", setSideWidth(e.clientX));
      handle.classList.remove("drag");
      document.body.classList.remove("resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", () => store("sideWidth", setSideWidth(SIDE_DEFAULT)));
}

// ---------------------------------------------------------------- boot

(async function boot() {
  applyMacLabels();
  api
    .appVersion()
    .then((v) => ($("app-version").textContent = `版本 ${v}`))
    .catch(() => {});
  const recent = storage<string[]>("recent", []);
  $("recent").innerHTML = recent.map((p) => `<li data-path="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(p)}</li>`).join("");
  renderFilters();
  await Promise.all(listeners);
  await folderTree.init();
  await restoreMusic();
  // 每次啟動都用預設瀏覽器開啟官網
  api.openWebsite().catch(() => {});
  const initial = await api.initialFolder().catch(() => null);
  renderTabs();
  if (tabs.length) {
    // 還原上次的分頁；啟動時指定了資料夾就另開一個分頁
    if (initial && !tabs.some((t) => t.dir === initial)) {
      tabs.push({ dir: initial });
      activeTab = tabs.length - 1;
    }
    await openTab(tabs[activeTab]);
  } else {
    const start = initial ?? storage<string | null>("last", null);
    if (start) await openFolderOrParent(start);
  }
})();
