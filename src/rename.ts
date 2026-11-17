// 批次重新命名（仿 Adobe Bridge「重新命名批次處理」）：
// 預設集、目的地（相同資料夾 / 移動 / 拷貝）、可增減的命名規則、保留原始檔名、相容性、即時預覽。

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Item, Meta, TransferResult } from "./api";

export type Rule =
  | { t: "text"; text: string }
  | { t: "seq"; start: number; digits: number }
  | { t: "name"; mode: "keep" | "upper" | "lower" }
  | { t: "date"; src: "capture" | "modified" | "today"; fmt: string }
  | { t: "meta"; field: "camera" | "lens" | "iso" | "focal" | "aperture" | "shutter" | "rating" | "label" }
  | { t: "replace"; find: string; repl: string; all: boolean; ci: boolean };

export interface RenameSettings {
  rules: Rule[];
  dest: "rename" | "move" | "copy";
  destDir: string;
  preserve: boolean;
  win: boolean;
  unix: boolean;
}

interface Preset {
  name: string;
  s: RenameSettings;
}

const DEFAULT: RenameSettings = {
  rules: [
    { t: "text", text: "" },
    { t: "seq", start: 1, digits: 3 },
  ],
  dest: "rename",
  destDir: "",
  preserve: false,
  win: false,
  unix: false,
};

const RULE_TYPES: [Rule["t"], string][] = [
  ["text", "文字"],
  ["seq", "順序編號"],
  ["name", "目前檔名"],
  ["date", "日期時間"],
  ["meta", "中繼資料"],
  ["replace", "字串替代"],
];

const DATE_FORMATS = ["YYYYMMDD", "YYYY-MM-DD", "YYMMDD", "YYYYMMDD_HHmmss", "YYYY-MM-DD_HHmmss", "HHmmss", "YYYY", "MMDD"];

const META_FIELDS: [string, string][] = [
  ["camera", "相機型號"],
  ["lens", "鏡頭"],
  ["iso", "ISO"],
  ["focal", "焦距"],
  ["aperture", "光圈"],
  ["shutter", "快門"],
  ["rating", "評等"],
  ["label", "標籤"],
];

function newRule(t: Rule["t"]): Rule {
  switch (t) {
    case "text":
      return { t, text: "" };
    case "seq":
      return { t, start: 1, digits: 3 };
    case "name":
      return { t, mode: "keep" };
    case "date":
      return { t, src: "capture", fmt: "YYYYMMDD" };
    case "meta":
      return { t, field: "camera" };
    case "replace":
      return { t, find: "", repl: "", all: true, ci: false };
  }
}

// ------------------------------------------------------------ 命名規則引擎

export interface NameCtx {
  name: string;
  index: number;
  meta?: Meta;
  mtime: number;
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}

function formatDate(d: Date, fmt: string) {
  return fmt
    .replace("YYYY", String(d.getFullYear()))
    .replace("YY", String(d.getFullYear()).slice(2))
    .replace("MM", pad(d.getMonth() + 1))
    .replace("DD", pad(d.getDate()))
    .replace("HH", pad(d.getHours()))
    .replace("mm", pad(d.getMinutes()))
    .replace("ss", pad(d.getSeconds()));
}

function parseCapture(s?: string | null): Date | null {
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function part(r: Rule, c: NameCtx): string {
  const m = c.meta;
  switch (r.t) {
    case "text":
      return r.text;
    case "seq":
      return String(Math.max(0, r.start + c.index)).padStart(Math.max(1, r.digits), "0");
    case "name":
      return r.mode === "upper" ? c.name.toUpperCase() : r.mode === "lower" ? c.name.toLowerCase() : c.name;
    case "date": {
      const d = r.src === "today" ? new Date() : r.src === "capture" ? (parseCapture(m?.capture) ?? new Date(c.mtime)) : new Date(c.mtime);
      return formatDate(d, r.fmt);
    }
    case "meta":
      switch (r.field) {
        case "camera":
          return m?.camera ?? "";
        case "lens":
          return m?.lens ?? "";
        case "iso":
          return m?.iso ? `ISO${m.iso}` : "";
        case "focal":
          return m?.focal ? `${m.focal}mm` : "";
        case "aperture":
          return m?.aperture ? `f${m.aperture}` : "";
        case "shutter":
          return m?.shutter ? m.shutter.replace("/", "-") : "";
        case "rating":
          return m && m.rating > 0 ? String(m.rating) : "";
        case "label":
          return m?.label ?? "";
      }
      return "";
    case "replace": {
      if (!r.find) return c.name;
      const re = new RegExp(escapeRe(r.find), (r.all ? "g" : "") + (r.ci ? "i" : ""));
      return c.name.replace(re, r.repl);
    }
  }
}

/** 依各作業系統的檔名限制清理（Mac 一律檢查） */
function sanitize(s: string, win: boolean, unix: boolean) {
  let out = s.replace(/[/:]/g, "-"); // Mac（含 Unix 的 /）
  if (unix) out = out.replace(/\0/g, "");
  if (win) out = out.replace(/[\\*?"<>|]/g, "-").replace(/[. ]+$/, "");
  return out.trim();
}

export function buildName(rules: Rule[], c: NameCtx, s: Pick<RenameSettings, "win" | "unix">): string {
  const name = sanitize(rules.map((r) => part(r, c)).join(""), s.win, s.unix);
  return name || c.name;
}

// ------------------------------------------------------------ 介面

export interface RenameHost {
  session(): number;
  /** 套用的項目（依目前排序）：已選取的、或目前顯示的全部 */
  targets(scope: "selected" | "view"): Item[];
  selectedCount(): number;
  viewCount(): number;
  meta(id: number): Meta | undefined;
  run(entries: { id: number; stem: string }[], s: RenameSettings): Promise<TransferResult>;
  done(s: RenameSettings, firstNewName: string | null): void;
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
    /* ignore */
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export class BatchRename {
  private s: RenameSettings = structuredClone(storage<RenameSettings>("renameLast", DEFAULT));
  private presets: Preset[] = storage<Preset[]>("renamePresets", []);
  private scope: "selected" | "view" = "selected";
  private el: HTMLElement;
  private busy = false;

  constructor(
    root: HTMLElement,
    private host: RenameHost,
  ) {
    this.el = root;
    this.el.addEventListener("input", (e) => this.onInput(e));
    this.el.addEventListener("change", (e) => this.onInput(e));
    this.el.addEventListener("click", (e) => this.onClick(e));
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  open() {
    this.scope = this.host.selectedCount() > 1 ? "selected" : "view";
    this.el.classList.remove("hidden");
    this.render();
    (this.el.querySelector<HTMLInputElement>(".rule-row input") ?? this.el.querySelector<HTMLButtonElement>("[data-act=run]"))?.focus();
  }

  close() {
    this.el.classList.add("hidden");
  }

  private q<T extends HTMLElement>(sel: string) {
    return this.el.querySelector<T>(sel)!;
  }

  private render() {
    const s = this.s;
    const presetOpts =
      `<option value="">（目前設定）</option>` +
      this.presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
    const rules = s.rules.map((r, i) => this.ruleRow(r, i)).join("");
    const nSel = this.host.selectedCount();
    this.el.querySelector(".modal-box")!.innerHTML = `
      <h2>批次重新命名</h2>
      <div class="br-section"><h3>預設集</h3>
        <div class="br-row">
          <select data-f="preset">${presetOpts}</select>
          <input data-f="preset-name" type="text" placeholder="預設集名稱" />
          <button data-act="save-preset" title="把目前的設定存成預設集">儲存</button>
          <button data-act="del-preset" title="刪除選取的預設集">刪除</button>
        </div>
      </div>
      <div class="br-section"><h3>目的地檔案夾</h3>
        <label class="br-radio"><input type="radio" name="br-dest" value="rename" ${s.dest === "rename" ? "checked" : ""}/> 在相同檔案夾中重新命名</label>
        <label class="br-radio"><input type="radio" name="br-dest" value="move" ${s.dest === "move" ? "checked" : ""}/> 移至其他檔案夾</label>
        <label class="br-radio"><input type="radio" name="br-dest" value="copy" ${s.dest === "copy" ? "checked" : ""}/> 拷貝到其他檔案夾</label>
        <div class="br-row">
          <button data-act="browse" ${s.dest === "rename" ? "disabled" : ""}>瀏覽…</button>
          <span class="muted small br-dest">${s.dest === "rename" ? "" : esc(s.destDir || "尚未選擇資料夾")}</span>
        </div>
      </div>
      <div class="br-section"><h3>新增檔名</h3>
        <div class="br-rules">${rules}</div>
      </div>
      <div class="br-section"><h3>選項</h3>
        <label class="br-check"><input type="checkbox" data-f="preserve" ${s.preserve ? "checked" : ""}/> 在 XMP 中繼資料中保留目前的檔名</label>
        <div class="br-row">相容性
          <label class="br-check"><input type="checkbox" data-f="win" ${s.win ? "checked" : ""}/> Windows</label>
          <label class="br-check muted"><input type="checkbox" checked disabled/> Mac</label>
          <label class="br-check"><input type="checkbox" data-f="unix" ${s.unix ? "checked" : ""}/> Unix</label>
        </div>
        <div class="br-row">套用到
          <label class="br-check"><input type="radio" name="br-scope" value="selected" ${this.scope === "selected" ? "checked" : ""} ${nSel ? "" : "disabled"}/> 已選取的 ${nSel} 張</label>
          <label class="br-check"><input type="radio" name="br-scope" value="view" ${this.scope === "view" ? "checked" : ""}/> 目前顯示的全部 ${this.host.viewCount()} 張</label>
        </div>
      </div>
      <div class="br-section"><h3>預覽</h3><div class="br-preview"></div></div>
      <div class="br-errors"></div>
      <div class="modal-actions">
        <span></span>
        <button data-act="cancel">取消</button>
        <button data-act="run" class="primary">重新命名</button>
      </div>`;
    this.renderPreview();
  }

  private ruleRow(r: Rule, i: number) {
    const types = RULE_TYPES.map(([t, n]) => `<option value="${t}" ${t === r.t ? "selected" : ""}>${n}</option>`).join("");
    let fields = "";
    switch (r.t) {
      case "text":
        fields = `<input type="text" data-k="text" value="${esc(r.text)}" placeholder="輸入文字" />`;
        break;
      case "seq":
        fields = `<input type="number" data-k="start" value="${r.start}" min="0" title="起始編號" />
          <select data-k="digits">${[1, 2, 3, 4, 5, 6].map((d) => `<option value="${d}" ${d === r.digits ? "selected" : ""}>${["一", "二", "三", "四", "五", "六"][d - 1]}碼</option>`).join("")}</select>`;
        break;
      case "name":
        fields = `<select data-k="mode">${[["keep", "原樣"], ["upper", "大寫"], ["lower", "小寫"]].map(([v, n]) => `<option value="${v}" ${v === r.mode ? "selected" : ""}>${n}</option>`).join("")}</select>`;
        break;
      case "date":
        fields = `<select data-k="src">${[["capture", "拍攝日期"], ["modified", "修改日期"], ["today", "今天"]].map(([v, n]) => `<option value="${v}" ${v === r.src ? "selected" : ""}>${n}</option>`).join("")}</select>
          <select data-k="fmt">${DATE_FORMATS.map((f) => `<option ${f === r.fmt ? "selected" : ""}>${f}</option>`).join("")}</select>`;
        break;
      case "meta":
        fields = `<select data-k="field">${META_FIELDS.map(([v, n]) => `<option value="${v}" ${v === r.field ? "selected" : ""}>${n}</option>`).join("")}</select>`;
        break;
      case "replace":
        fields = `<input type="text" data-k="find" value="${esc(r.find)}" placeholder="尋找（目前檔名中的文字）" />
          <input type="text" data-k="repl" value="${esc(r.repl)}" placeholder="取代為" />
          <label class="br-check" title="取代全部出現的地方"><input type="checkbox" data-k="all" ${r.all ? "checked" : ""}/> 全部</label>
          <label class="br-check" title="不分大小寫"><input type="checkbox" data-k="ci" ${r.ci ? "checked" : ""}/> 不分大小寫</label>`;
        break;
    }
    return `<div class="rule-row" data-i="${i}">
      <select data-k="t">${types}</select>
      <div class="rule-fields">${fields}</div>
      <button data-act="del-rule" title="移除這個規則" ${this.s.rules.length <= 1 ? "disabled" : ""}>−</button>
      <button data-act="add-rule" title="在下方新增規則">+</button>
    </div>`;
  }

  private items(): Item[] {
    return this.host.targets(this.scope);
  }

  private planned(): { it: Item; stem: string }[] {
    return this.items().map((it, index) => ({
      it,
      stem: buildName(this.s.rules, { name: it.name, index, meta: this.host.meta(it.id), mtime: it.mtime }, this.s),
    }));
  }

  private renderPreview() {
    const plan = this.planned();
    const box = this.q(".br-preview");
    if (!plan.length) {
      box.innerHTML = `<p class="muted">沒有要處理的照片</p>`;
      this.q<HTMLButtonElement>("[data-act=run]").disabled = true;
      return;
    }
    const counts = new Map<string, number>();
    plan.forEach((p) => counts.set(p.stem.toLowerCase(), (counts.get(p.stem.toLowerCase()) ?? 0) + 1));
    const dups = plan.filter((p) => counts.get(p.stem.toLowerCase())! > 1).length;
    const files = plan.reduce((n, p) => n + p.it.files.length, 0);
    const first = plan[0];
    const ext = (f: string) => (f.includes(".") ? f.slice(f.lastIndexOf(".")) : "");
    const rows = plan
      .slice(0, 300)
      .map((p) => {
        const dup = counts.get(p.stem.toLowerCase())! > 1;
        const names = p.it.files.map((f) => `${p.stem}${ext(f)}`).join("、");
        return `<tr class="${dup ? "dup" : ""}"><td>${esc(p.it.files.join("、"))}</td><td>→</td><td>${esc(names)}</td></tr>`;
      })
      .join("");
    box.innerHTML = `
      <div>目前的檔名 <b>${esc(first.it.files[0])}</b></div>
      <div>新檔案名稱 <b>${esc(first.stem + ext(first.it.files[0]))}</b></div>
      <div>將會處理 ${plan.length} 張照片（共 ${files} 個檔案，含配對的 RAW / JPEG）${dups ? `<span class="br-warn">　⚠ 有 ${dups} 張新檔名重複，請加入順序編號</span>` : ""}</div>
      <div class="br-table"><table>${rows}</table>${plan.length > 300 ? `<p class="muted small">（只顯示前 300 筆）</p>` : ""}</div>`;
    const needDir = this.s.dest !== "rename" && !this.s.destDir;
    this.q<HTMLButtonElement>("[data-act=run]").disabled = dups > 0 || needDir || this.busy;
  }

  private ruleAt(e: Event): [number, HTMLElement] | null {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".rule-row");
    return row ? [Number(row.dataset.i), row] : null;
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    const k = t.dataset.k;
    const ri = this.ruleAt(e);
    if (ri && k) {
      const [i] = ri;
      if (k === "t") {
        if (e.type !== "change") return;
        this.s.rules[i] = newRule(t.value as Rule["t"]);
        this.save();
        this.render();
        return;
      }
      const r = this.s.rules[i] as Record<string, unknown>;
      r[k] = t.type === "checkbox" ? t.checked : t.type === "number" || k === "digits" ? Number(t.value) : t.value;
    } else if (t.name === "br-dest") {
      this.s.dest = t.value as RenameSettings["dest"];
      this.save();
      this.render();
      return;
    } else if (t.name === "br-scope") {
      this.scope = t.value as "selected" | "view";
    } else if (t.dataset.f === "preserve" || t.dataset.f === "win" || t.dataset.f === "unix") {
      (this.s as unknown as Record<string, boolean>)[t.dataset.f] = t.checked;
    } else if (t.dataset.f === "preset" && e.type === "change") {
      const p = this.presets[Number(t.value)];
      if (t.value !== "" && p) {
        this.s = structuredClone(p.s);
        this.save();
        this.render();
        this.q<HTMLSelectElement>("[data-f=preset]").value = t.value;
        this.q<HTMLInputElement>("[data-f=preset-name]").value = p.name;
      }
      return;
    } else {
      return;
    }
    this.save();
    this.renderPreview();
  }

  private async onClick(e: Event) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const ri = this.ruleAt(e);
    if (act === "add-rule" && ri) {
      this.s.rules.splice(ri[0] + 1, 0, newRule("text"));
    } else if (act === "del-rule" && ri && this.s.rules.length > 1) {
      this.s.rules.splice(ri[0], 1);
    } else if (act === "browse") {
      const d = await openDialog({ directory: true, title: this.s.dest === "move" ? "移至…" : "拷貝到…" });
      if (typeof d === "string") this.s.destDir = d;
    } else if (act === "save-preset") {
      const name = this.q<HTMLInputElement>("[data-f=preset-name]").value.trim() || `預設集 ${this.presets.length + 1}`;
      const idx = this.presets.findIndex((p) => p.name === name);
      const p = { name, s: structuredClone(this.s) };
      if (idx >= 0) this.presets[idx] = p;
      else this.presets.push(p);
      store("renamePresets", this.presets);
      this.render();
      this.q<HTMLSelectElement>("[data-f=preset]").value = String(idx >= 0 ? idx : this.presets.length - 1);
      this.q<HTMLInputElement>("[data-f=preset-name]").value = name;
      return;
    } else if (act === "del-preset") {
      const v = this.q<HTMLSelectElement>("[data-f=preset]").value;
      if (v !== "") {
        this.presets.splice(Number(v), 1);
        store("renamePresets", this.presets);
      }
    } else if (act === "cancel") {
      this.close();
      return;
    } else if (act === "run") {
      await this.run();
      return;
    } else {
      return;
    }
    this.save();
    this.render();
  }

  private save() {
    store("renameLast", this.s);
  }

  private async run() {
    const plan = this.planned();
    if (!plan.length || this.busy) return;
    this.busy = true;
    this.renderPreview();
    const errBox = this.q(".br-errors");
    errBox.innerHTML = `<p class="muted">處理中…</p>`;
    try {
      const r = await this.host.run(
        plan.map((p) => ({ id: p.it.id, stem: p.stem })),
        this.s,
      );
      if (r.failed.length) {
        errBox.innerHTML =
          `<p class="br-warn">${r.done ? `已完成 ${r.done} 張，` : ""}以下項目無法處理${r.done ? "" : "（沒有任何檔案被更動）"}：</p><ul>` +
          r.failed.slice(0, 30).map((f) => `<li>${esc(f)}</li>`).join("") +
          `</ul>`;
        if (r.done) this.host.done(this.s, null);
      } else {
        errBox.innerHTML = "";
        this.close();
        this.host.done(this.s, plan[0].stem);
      }
    } catch (e) {
      errBox.innerHTML = `<p class="br-warn">${esc(String(e))}</p>`;
    } finally {
      this.busy = false;
      if (this.isOpen) this.renderPreview();
    }
  }
}
