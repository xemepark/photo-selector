import { listen } from "@tauri-apps/api/event";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import {
  api,
  url,
  Item,
  Meta,
  OpenResult,
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
} from "./api";
import { Grid } from "./grid";
import { BatchRename } from "./rename";
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

type FilterKey = "suggest" | "eyes" | "sharp" | "rating" | "label" | "kind" | "camera" | "lens";

const cull = new Cull();

const S = {
  session: 0,
  dir: "",
  parent: null as string | null,
  items: [] as Item[],
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
  focusId: () => S.focus,
  badges: (id) => cull.badges(id),
  onCellClick,
  onCellMenu: (i, ev) => showCellMenu(i, ev),
  onCellOpen: (i) => {
    setFocus(S.view[i].id, false);
    openLoupe();
  },
  onViewport: debounce((ids: number[]) => api.setViewport(S.session, ids).catch(() => {}), 30),
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
  "raw+jpeg": "RAW + JPEG",
  raw: "RAW",
  jpeg: "JPEG",
  image: "其他影像",
  other: "其他格式",
};

function facet(key: FilterKey, it: Item): string {
  const m = S.meta.get(it.id);
  switch (key) {
    case "rating": {
      const r = m?.rating ?? 0;
      return r < 0 ? "rej" : String(r);
    }
    case "label":
      return m?.label ? (labelKey(m.label) ?? "other") : "none";
    case "kind":
      return it.kind;
    case "camera":
      return m?.camera ?? "未知";
    case "lens":
      return m?.lens ?? "未知";
    case "suggest":
    case "eyes":
    case "sharp":
      return cull.facet(key, it.id);
  }
}

const FILTER_KEYS: FilterKey[] = ["suggest", "eyes", "sharp", "rating", "label", "kind", "camera", "lens"];

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
    return c;
  };
  const dyn = (k: FilterKey) =>
    [...counts(k).keys()].sort((a, b) => (a === "未知" ? 1 : b === "未知" ? -1 : collator.compare(a, b))).map((v) => [v, v] as [string, string]);

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
  groups.push(["kind", "檔案類型", Object.entries(KIND_NAMES)]);
  groups.push(["camera", "相機", dyn("camera")]);
  groups.push(["lens", "鏡頭", dyn("lens")]);

  let html = "";
  for (const [key, title, rows] of groups) {
    const c = counts(key);
    const visible = rows.filter(([v]) => (c.get(v) ?? 0) > 0 || S.filters[key].has(v));
    const always = key === "rating" || key === "suggest" || key === "eyes" || key === "sharp";
    if (!visible.length || (!always && visible.length < 2 && !S.filters[key].size)) continue;
    html += `<div class="filter-group"><h4>${title}</h4>`;
    for (const [v, label] of visible) {
      const on = S.filters[key].has(v);
      const lc = key === "label" && v !== "none" && v !== "other" ? LABELS.find((l) => l.key === v)?.color : null;
      const dot = lc ? `<span class="dot" style="background:${lc}"></span>` : "";
      html += `<div class="filter-row${on ? " on" : ""}" data-k="${key}" data-v="${escapeHtml(v)}">
        <input type="checkbox" ${on ? "checked" : ""}>${dot}<span class="label">${escapeHtml(label)}</span>
        <span class="n">${c.get(v) ?? 0}</span></div>`;
    }
    html += `</div>`;
  }
  box.innerHTML = html || `<p class="muted small">開啟資料夾後顯示</p>`;
}

$("filters").addEventListener("click", (ev) => {
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
}


// ---------------------------------------------------------------- folder

async function openFolder(path: string) {
  let res: OpenResult;
  try {
    res = await api.openFolder(path);
  } catch (e) {
    toast(String(e));
    return;
  }
  Object.assign(S, {
    session: res.session,
    dir: res.dir,
    parent: res.parent,
    items: res.items,
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

  pathInput.value = res.dir;
  pathInput.scrollLeft = pathInput.scrollWidth;
  $("empty").classList.toggle("hidden", true);
  const f = $("folders");
  f.innerHTML =
    (res.parent ? `<li class="up" data-path="${escapeHtml(res.parent)}">↰ 上一層</li>` : "") +
    res.subdirs.map((d) => `<li data-path="${escapeHtml(d.path)}" title="${escapeHtml(d.path)}">📁 ${escapeHtml(d.name)}</li>`).join("");
  gridEl.scrollTop = 0;
  update({ resetGrid: true });
  gridEl.focus();
  if (!res.items.length) toast("這個資料夾沒有支援的照片");
}

async function pickFolder() {
  const dir = await openDialog({ directory: true, defaultPath: S.dir || undefined });
  if (typeof dir === "string") openFolder(dir);
}

$("folders").addEventListener("click", (ev) => {
  const li = (ev.target as HTMLElement).closest("li") as HTMLElement | null;
  if (li?.dataset.path) openFolder(li.dataset.path);
});
$("btn-open").addEventListener("click", pickFolder);
$("btn-open-2").addEventListener("click", pickFolder);
$("btn-up").addEventListener("click", () => S.parent && openFolder(S.parent));
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
  } else if (!(S.selected.has(id) && S.selected.size > 1 && ev.button === 2)) {
    setFocus(id, false);
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
    if (r.failed.length) toast(`有 ${r.failed.length} 個項目無法刪除：${r.failed.join("、")}`, 6000);
    else toast(`已將${what}移到垃圾桶`, 2000);
  } catch (e) {
    toast(`刪除失敗：${e}`);
  } finally {
    deleting = false;
  }
}

function targets(): number[] {
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
  clearImg(loupeImg);
  faceLayer.innerHTML = "";
  gridEl.focus();
}

function showLoupe() {
  if (S.focus === null) return;
  S.zoom = false;
  stage.classList.remove("zoom");
  faceLayer.innerHTML = "";
  startChain(S.focus);
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
  if (S.focus === null) return;
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
  if (mode === "move" && !(await ask(`確定要把 ${ids.length} 個項目（含配對的 RAW/JPEG 與 .xmp）移動到\n${dest}？`, { title: "移動檔案", okLabel: "確定", cancelLabel: "取消" })))
    return;
  try {
    const r = await api.transfer(S.session, ids, dest, mode);
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


// ---------------------------------------------------------------- keyboard

document.addEventListener("keydown", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
  const mod = ev.ctrlKey || ev.metaKey;
  const k = ev.key;

  // 對話框開著時，鍵盤只用來關閉它（不要誤評分背景的照片）
  if (!ctxMenu.classList.contains("hidden") && k === "Escape") return ev.preventDefault(), hideMenu();
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
    void deleteTargets();
    return;
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
    case "batch-rename":
      openBatchRename();
      break;
    case "goto":
      focusPath();
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
  try {
    const r = await api.resolvePath(text);
    await openFolder(r.dir);
    if (r.file) {
      // 貼上的是照片的路徑 → 開啟所在資料夾並選取那張照片
      const it = S.items.find((i) => i.files.some((f) => f.toLowerCase() === r.file!.toLowerCase()));
      if (it && S.viewIndex.has(it.id)) setFocus(it.id, false);
    }
    gridEl.focus();
  } catch (e) {
    toast(String(e), 4000);
    pathInput.select();
  }
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
    ["reveal", isMac ? "在 Finder 中顯示" : "在檔案總管中顯示"],
    ["rename", "重新命名…", "F2"],
    ["batch", n > 1 ? `批次重新命名 ${n} 張…` : "批次重新命名…", "⇧⌘R"],
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
  if (!a || S.focus === null) return;
  if (a === "reveal") api.revealItem(S.session, S.focus).catch((e) => toast(`無法開啟：${e}`));
  else if (a === "rename") openRename();
  else if (a === "batch") openBatchRename();
  else if (a === "copy") void transfer("copy");
  else if (a === "move") void transfer("move");
  else if (a === "trash") void deleteTargets();
});
document.addEventListener("mousedown", (ev) => {
  if (!ctxMenu.contains(ev.target as Node)) hideMenu();
});
gridEl.addEventListener("scroll", hideMenu, { passive: true });
window.addEventListener("blur", hideMenu);

// ---------------------------------------------------------------- 重新命名（單張）

const renameDialog = $("rename-dialog");
const renameInput = $<HTMLInputElement>("rename-input");
let renameId: number | null = null;

function openRename() {
  if (S.focus === null) return;
  const it = S.items[S.focus];
  renameId = it.id;
  renameInput.value = it.name;
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
  if (stem === S.items[renameId].name) {
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
  await reloadFolder(stem);
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
  run: (entries, s) => api.batchRename(S.session, entries, s.dest, s.dest === "rename" ? null : s.destDir, s.preserve),
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
  await restoreMusic();
  const start = (await api.initialFolder().catch(() => null)) ?? storage<string | null>("last", null);
  if (start) await openFolder(start);
})();
