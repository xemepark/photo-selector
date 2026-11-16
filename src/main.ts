import { listen } from "@tauri-apps/api/event";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import { api, url, Item, Meta, OpenResult, LABELS, labelColor, stars, fmtBytes } from "./api";
import { Grid } from "./grid";

// ---------------------------------------------------------------- state

type FilterKey = "rating" | "label" | "kind" | "camera" | "lens" | "sharp";

const S = {
  session: 0,
  dir: "",
  parent: null as string | null,
  items: [] as Item[],
  meta: new Map<number, Meta>(),
  overrides: new Map<number, Partial<Meta>>(), // 中繼資料還沒讀到前，使用者就先評分的值
  sharp: new Map<number, number>(),
  blurThreshold: 0,
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
  } as Record<FilterKey, Set<string>>,
  sort: "name",
  sortDesc: false,
  metaLoaded: 0,
  sharpPending: false,
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
  isBlurry,
  onCellClick,
  onCellOpen: (i) => {
    setFocus(S.view[i].id, false);
    openLoupe();
  },
  onViewport: debounce((ids: number[]) => api.setViewport(S.session, ids).catch(() => {}), 30),
});

// ---------------------------------------------------------------- helpers

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t = 0;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

function toast(msg: string, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout((toast as any).t);
  (toast as any).t = setTimeout(() => t.classList.add("hidden"), ms);
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

function isBlurry(id: number) {
  const s = S.sharp.get(id);
  return s !== undefined && S.blurThreshold > 0 && s < S.blurThreshold;
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
      return m?.label ? m.label : "none";
    case "kind":
      return it.kind;
    case "camera":
      return m?.camera ?? "未知";
    case "lens":
      return m?.lens ?? "未知";
    case "sharp":
      return !S.sharp.has(it.id) ? "na" : isBlurry(it.id) ? "blur" : "ok";
  }
}

const FILTER_KEYS: FilterKey[] = ["rating", "label", "kind", "sharp", "camera", "lens"];

function passes(it: Item) {
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
      return S.sharp.get(it.id) ?? -1;
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
    for (const it of S.items) {
      const v = facet(k, it);
      c.set(v, (c.get(v) ?? 0) + 1);
    }
    return c;
  };
  const dyn = (k: FilterKey) =>
    [...counts(k).keys()].sort((a, b) => (a === "未知" ? 1 : b === "未知" ? -1 : collator.compare(a, b))).map((v) => [v, v] as [string, string]);

  groups.push(["rating", "評等", RATING_ROWS]);
  groups.push([
    "label",
    "標籤",
    [["none", "無標籤"], ...LABELS.map((l) => [l.value, l.name] as [string, string])],
  ]);
  groups.push(["kind", "檔案類型", Object.entries(KIND_NAMES)]);
  if (S.sharp.size)
    groups.push(["sharp", "清晰度", [["blur", "可能模糊"], ["ok", "清晰"], ["na", "未分析"]]]);
  groups.push(["camera", "相機", dyn("camera")]);
  groups.push(["lens", "鏡頭", dyn("lens")]);

  let html = "";
  for (const [key, title, rows] of groups) {
    const c = counts(key);
    const visible = rows.filter(([v]) => (c.get(v) ?? 0) > 0 || S.filters[key].has(v));
    if (!visible.length || (key !== "rating" && visible.length < 2 && !S.filters[key].size)) continue;
    html += `<div class="filter-group"><h4>${title}</h4>`;
    for (const [v, label] of visible) {
      const on = S.filters[key].has(v);
      const lc = key === "label" && v !== "none" ? labelColor(v) : null;
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
  if (opts.resetGrid) grid.reset();
  else grid.render();
  grid.refresh();
  renderInfo();
  renderStatus();
  if (S.loupe) renderLoupeInfo();
  if (S.compare.length) renderCompare(false);
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

function renderStatus() {
  const total = S.items.length;
  const shown = S.view.length;
  const sel = S.selected.size;
  $("count").textContent = total
    ? `${shown === total ? `${total} 個項目` : `顯示 ${shown} / ${total}`}${sel > 1 ? ` · 已選取 ${sel}` : ""}`
    : "";
  let p = "";
  if (total && S.metaLoaded < total) p = `讀取中繼資料 ${S.metaLoaded}/${total}`;
  if (S.sharpPending) p += `${p ? " · " : ""}分析清晰度 ${S.sharp.size}/${total}`;
  $("progress").textContent = p;
}

function renderInfo() {
  const box = $("info");
  if (S.focus === null) {
    box.innerHTML = `<p class="muted">尚未選取照片</p>`;
    return;
  }
  const it = S.items[S.focus];
  const m = S.meta.get(it.id);
  const rows: [string, string | undefined | null][] = [
    ["檔案", it.files.join("\n")],
    ["大小", fmtBytes(it.size)],
    ["拍攝", m?.capture],
    ["相機", m?.camera],
    ["鏡頭", m?.lens],
    [
      "曝光",
      [m?.shutter && `${m.shutter}`, m?.aperture && `f/${m.aperture}`, m?.iso && `ISO ${m.iso}`, m?.focal && `${m.focal}mm`]
        .filter(Boolean)
        .join("  "),
    ],
    ["尺寸", m?.width && m?.height ? `${m.width} × ${m.height}` : null],
    ["評等", m ? stars(m.rating) || "—" : null],
    ["標籤", m?.label ? LABELS.find((l) => l.value === m.label)?.name ?? m.label : null],
    ["清晰度", S.sharp.has(it.id) ? `${S.sharp.get(it.id)!.toFixed(0)}${isBlurry(it.id) ? "（可能模糊）" : ""}` : null],
  ];
  box.innerHTML =
    "<dl>" +
    rows
      .filter(([, v]) => v)
      .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v)).replace(/\n/g, "<br>")}</dd>`)
      .join("") +
    "</dl>";
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
    sharpPending: false,
    blurThreshold: 0,
  });
  S.meta.clear();
  S.overrides.clear();
  S.sharp.clear();
  S.selected = new Set(res.items.length ? [0] : []);
  for (const k of FILTER_KEYS) S.filters[k].clear();

  const recent = [res.dir, ...storage<string[]>("recent", []).filter((p) => p !== res.dir)].slice(0, 8);
  store("recent", recent);
  store("last", res.dir);

  $("path").textContent = res.dir;
  $("path").title = res.dir;
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

listen<{ session: number; metas: [number, Meta][] }>("meta-batch", (e) => {
  if (e.payload.session !== S.session) return;
  for (const [id, m] of e.payload.metas) {
    const o = S.overrides.get(id);
    S.meta.set(id, o ? { ...m, ...o } : m);
  }
  S.metaLoaded += e.payload.metas.length;
  scheduleUpdate();
});
listen<number>("meta-done", (e) => {
  if (e.payload !== S.session) return;
  S.metaLoaded = S.items.length;
  scheduleUpdate();
});

// ---------------------------------------------------------------- sharpness

function recomputeBlurThreshold() {
  const v = [...S.sharp.values()].sort((a, b) => a - b);
  if (v.length < 3) {
    S.blurThreshold = 0;
    return;
  }
  const median = v[Math.floor(v.length / 2)];
  // 明顯低於這一批照片中位數的，才標為可能模糊
  S.blurThreshold = median * 0.35;
}

$("btn-sharp").addEventListener("click", async () => {
  if (!S.items.length || S.sharpPending) return;
  S.sharpPending = true;
  renderStatus();
  // 先分析畫面上的，再分析其他的
  const ids = [...S.view.map((i) => i.id), ...S.items.filter((i) => !S.viewIndex.has(i.id)).map((i) => i.id)];
  await api.analyzeSharpness(S.session, ids).catch((e) => toast(String(e)));
});
listen<{ session: number; scores: [number, number][] }>("sharp-batch", (e) => {
  if (e.payload.session !== S.session) return;
  for (const [id, s] of e.payload.scores) S.sharp.set(id, s);
  recomputeBlurThreshold();
  scheduleUpdate();
});
listen<number>("sharp-done", (e) => {
  if (e.payload !== S.session) return;
  S.sharpPending = false;
  recomputeBlurThreshold();
  const n = S.items.filter((i) => isBlurry(i.id)).length;
  toast(`清晰度分析完成：${n} 張可能模糊（可在左側「清晰度」篩選）`, 4000);
  update({ resetGrid: true });
});

// ---------------------------------------------------------------- selection

function setFocus(id: number, extend: boolean) {
  S.focus = id;
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
  renderInfo();
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
    renderInfo();
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
function targets(): number[] {
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

async function applyLabel(label: string) {
  const ids = targets();
  if (!ids.length) return;
  const value = ids.every((id) => metaOf(id).label === label) ? null : label;
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
  if (!($("auto-advance") as HTMLInputElement).checked || ids.length !== 1 || S.compare.length) return null;
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
const prefetched: HTMLImageElement[] = [];

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
  loupeImg.removeAttribute("src");
  gridEl.focus();
}

function showLoupe() {
  if (S.focus === null) return;
  S.zoom = false;
  stage.classList.remove("zoom");
  loupeImg.src = url.preview(S.session, S.focus);
  renderLoupeInfo();
  // 預先載入前後兩張，翻頁時幾乎零等待
  prefetched.length = 0;
  const i = S.viewIndex.get(S.focus) ?? 0;
  for (const d of [1, -1, 2, -2]) {
    const n = S.view[i + d];
    if (n) {
      const im = new Image();
      im.src = url.preview(S.session, n.id);
      prefetched.push(im);
    }
  }
}

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
    (isBlurry(it.id) ? `<span class="badge warn">可能模糊</span>` : "") +
    `<span class="muted">${[m?.shutter, m?.aperture && `f/${m.aperture}`, m?.iso && `ISO ${m.iso}`, m?.focal && `${m.focal}mm`]
      .filter(Boolean)
      .join(" · ")}</span>`;
}

function toggleZoom(ev?: MouseEvent) {
  if (S.focus === null) return;
  S.zoom = !S.zoom;
  if (!S.zoom) {
    stage.classList.remove("zoom");
    loupeImg.src = url.preview(S.session, S.focus);
    return;
  }
  // 以點擊位置為中心放大到 100%
  const r = loupeImg.getBoundingClientRect();
  const fx = ev ? (ev.clientX - r.left) / r.width : 0.5;
  const fy = ev ? (ev.clientY - r.top) / r.height : 0.5;
  stage.classList.add("zoom");
  loupeImg.src = url.full(S.session, S.focus);
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
      .map((id, i) => `<div class="cmp" data-i="${i}"><img src="${url.preview(S.session, id)}" alt=""><div class="overlay-info"></div></div>`)
      .join("");
  }
  g.querySelectorAll<HTMLElement>(".cmp").forEach((el, i) => {
    const id = S.compare[i];
    const m = S.meta.get(id);
    const lc = labelColor(m?.label);
    el.classList.toggle("active", i === S.compareActive);
    el.querySelector(".overlay-info")!.innerHTML =
      `<b>${escapeHtml(S.items[id].name)}</b><span class="stars${(m?.rating ?? 0) < 0 ? " rej" : ""}">${stars(m?.rating ?? 0)}</span>` +
      (lc ? `<span class="dot" style="background:${lc}"></span>` : "") +
      (isBlurry(id) ? `<span class="badge warn">可能模糊</span>` : "");
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
  if (mode === "move" && !(await ask(`確定要把 ${ids.length} 個項目（含配對的 RAW/JPEG 與 .xmp）移動到\n${dest}？`, { title: "移動檔案" })))
    return;
  try {
    const r = await api.transfer(S.session, ids, dest, mode);
    toast(`${mode === "copy" ? "已複製" : "已移動"} ${r.done} 個項目${r.failed.length ? `，${r.failed.length} 個檔案失敗` : ""}`, 4000);
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

async function refreshCacheInfo() {
  try {
    const [, bytes] = await api.cacheInfo();
    $("cache-info").textContent = `縮圖快取：${fmtBytes(bytes)}`;
  } catch {
    /* ignore */
  }
}
$("btn-clear-cache").addEventListener("click", async () => {
  if (!(await ask("清除所有縮圖與清晰度快取？下次瀏覽時會重新產生。", { title: "清除快取" }))) return;
  await api.clearCache();
  refreshCacheInfo();
  toast("快取已清除");
});

// ---------------------------------------------------------------- keyboard

document.addEventListener("keydown", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
  const mod = ev.ctrlKey || ev.metaKey;
  const k = ev.key;

  if (mod && k.toLowerCase() === "o") return ev.preventDefault(), void pickFolder();
  if ((mod && k === "ArrowUp") || (k === "Backspace" && !S.loupe && !S.compare.length)) {
    ev.preventDefault();
    if (S.parent) openFolder(S.parent);
    return;
  }

  // 評等 / 拒絕 / 標籤（格狀、全螢幕、比較模式通用）
  if (!ev.altKey && /^[0-5]$/.test(k) && !mod) return ev.preventDefault(), void applyRating(Number(k));
  if (k.toLowerCase() === "x" && !mod) return ev.preventDefault(), void applyRating("toggle-reject");
  const lab = LABELS.find((l) => l.key && l.key === k);
  if (lab) return ev.preventDefault(), void applyLabel(lab.value);

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
      if (mod && k.toLowerCase() === "a") {
        S.selected = new Set(S.view.map((i) => i.id));
        grid.refresh();
        renderStatus();
      } else if (k.toLowerCase() === "c" && !mod) openCompare();
      else return;
  }
  ev.preventDefault();
});

// ---------------------------------------------------------------- boot

(async function boot() {
  const recent = storage<string[]>("recent", []);
  $("recent").innerHTML = recent.map((p) => `<li data-path="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(p)}</li>`).join("");
  renderFilters();
  refreshCacheInfo();
  setInterval(refreshCacheInfo, 15000);
  const start = (await api.initialFolder().catch(() => null)) ?? storage<string | null>("last", null);
  if (start) await openFolder(start);
})();
