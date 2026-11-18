// 影像轉存（仿 Photoshop / Bridge「影像處理器」）：把選取的照片縮到指定尺寸、另存為 JPEG / TIFF / PNG

import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, ExportFormat, ExportOptions, ExportResult } from "./api";

interface FmtSettings {
  on: boolean;
  resize: boolean;
  w: number;
  h: number;
  quality: number; // JPEG 0–12
  lzw: boolean; // TIFF
}

interface Settings {
  sameDir: boolean;
  dest: string;
  jpeg: FmtSettings;
  tiff: FmtSettings;
  png: FmtSettings;
  toSrgb: boolean;
  embedIcc: boolean;
  copyright: string;
}

const FORMATS: { key: ExportFormat; label: string }[] = [
  { key: "jpeg", label: "JPEG" },
  { key: "tiff", label: "TIFF" },
  { key: "png", label: "PNG" },
];

const fmtDefault = (on: boolean): FmtSettings => ({ on, resize: false, w: 2400, h: 2400, quality: 12, lzw: true });

function defaults(): Settings {
  return {
    sameDir: true,
    dest: "",
    jpeg: { ...fmtDefault(true), resize: true },
    tiff: fmtDefault(false),
    png: fmtDefault(false),
    toSrgb: true,
    embedIcc: true,
    copyright: "",
  };
}

function load(): Settings {
  const d = defaults();
  try {
    const v = JSON.parse(localStorage.getItem("exportSettings") ?? "null");
    if (v && typeof v === "object")
      return { ...d, ...v, jpeg: { ...d.jpeg, ...v.jpeg }, tiff: { ...d.tiff, ...v.tiff }, png: { ...d.png, ...v.png } };
  } catch {
    /* ignore */
  }
  return d;
}

function save(s: Settings) {
  try {
    localStorage.setItem("exportSettings", JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export interface ExporterHost {
  session(): number;
  /** 目前選取（依畫面順序） */
  selectedIds(): number[];
  /** 「相同位置」時的資料夾（顯示用） */
  currentDir(): string;
  done(r: ExportResult): void;
  toast(msg: string): void;
}

export class Exporter {
  private s = load();
  private ids: number[] = [];
  private running = false;
  private q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;

  constructor(
    private el: HTMLElement,
    private host: ExporterHost,
  ) {
    el.innerHTML = this.markup();
    el.addEventListener("input", () => this.read());
    el.addEventListener("change", () => this.read());
    this.q("#ex-pick").addEventListener("click", () => void this.pickDest());
    this.q("#ex-cancel").addEventListener("click", () => this.cancel());
    this.q("#ex-run").addEventListener("click", () => void this.run());
    void listen<{ done: number; total: number }>("export-progress", (e) => {
      if (this.running) this.status(`轉存中… ${e.payload.done} / ${e.payload.total}`);
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  open() {
    this.ids = this.host.selectedIds();
    if (!this.ids.length) {
      this.host.toast("請先選取要轉存的照片");
      return;
    }
    this.s = load();
    this.fill();
    this.status("");
    this.q("#ex-count").textContent = `已選取 ${this.ids.length} 張照片`;
    this.el.classList.remove("hidden");
    this.q<HTMLButtonElement>("#ex-run").focus();
  }

  /** Esc：轉存中不關閉（要按「停止」） */
  close() {
    if (this.running) return;
    this.el.classList.add("hidden");
  }

  private markup() {
    const fmt = (f: { key: ExportFormat; label: string }) => `
      <div class="ex-fmt" data-fmt="${f.key}">
        <div class="ex-fmt-left">
          <label class="check"><input type="checkbox" data-k="on" /> 另存為 ${f.label}</label>
          ${
            f.key === "jpeg"
              ? `<label class="sub">品質 <input type="number" data-k="quality" min="0" max="12" step="1" /> <span class="muted small">（0–12，與 Photoshop 相同）</span></label>`
              : f.key === "tiff"
                ? `<label class="check sub"><input type="checkbox" data-k="lzw" /> LZW 壓縮</label>`
                : `<span class="muted small sub">無失真，檔案較大</span>`
          }
        </div>
        <div class="ex-fmt-right">
          <label class="check"><input type="checkbox" data-k="resize" /> 重新調整尺寸以符合</label>
          <label class="sub">W <input type="number" data-k="w" min="0" step="1" /> 像素</label>
          <label class="sub">H <input type="number" data-k="h" min="0" step="1" /> 像素</label>
        </div>
      </div>`;
    return `
    <div class="modal-box wide export-box">
      <h2>影像轉存</h2>
      <div class="ex-sec">
        <h3><b>1</b> 要處理的影像</h3>
        <p id="ex-count"></p>
        <p class="muted small">RAW+JPEG 使用相機 JPEG；只有 RAW 的照片使用 RAW 內嵌的相機預覽圖（尚未套用 Camera Raw 調整）。</p>
      </div>
      <div class="ex-sec">
        <h3><b>2</b> 儲存已處理影像的位置</h3>
        <label class="check"><input type="radio" name="ex-dest" value="same" /> 儲存至相同位置</label>
        <div class="ex-dest-row">
          <label class="check"><input type="radio" name="ex-dest" value="pick" /></label>
          <button id="ex-pick">選取檔案夾…</button>
          <span id="ex-dest-path" class="muted path"></span>
        </div>
        <p class="muted small">與 Photoshop 相同，會在該資料夾內建立 JPEG / TIFF / PNG 子資料夾；同名檔案不會被覆蓋（自動加 -1、-2…）。</p>
      </div>
      <div class="ex-sec">
        <h3><b>3</b> 檔案類型</h3>
        ${FORMATS.map(fmt).join("")}
        <p class="muted small">寬、高都填 2400 ＝ 長邊 2400（直幅、橫幅都適用）；只填一邊、另一邊填 0 ＝ 只限制那一邊。比原圖大時不會放大。</p>
      </div>
      <div class="ex-sec">
        <h3><b>4</b> 偏好設定</h3>
        <label class="check"><input type="checkbox" id="ex-srgb" /> 將描述檔轉換為 sRGB <span class="muted small">（網路、手機、LINE 分享建議勾選；Adobe RGB 檔不轉換會偏淡）</span></label>
        <label class="check"><input type="checkbox" id="ex-icc" /> 包含 ICC 描述檔</label>
        <label class="ex-copy">版權資訊 <input type="text" id="ex-copyright" placeholder="例如：© 小日子寫真館" spellcheck="false" /></label>
      </div>
      <div class="modal-actions">
        <span id="ex-status" class="muted"></span>
        <button id="ex-cancel">取消</button>
        <button id="ex-run" class="primary">執行</button>
      </div>
    </div>`;
  }

  private fill() {
    const s = this.s;
    this.el.querySelectorAll<HTMLInputElement>('input[name="ex-dest"]').forEach((r) => {
      r.checked = (r.value === "same") === (s.sameDir || !s.dest);
    });
    this.q("#ex-dest-path").textContent = s.dest || "（尚未選擇）";
    for (const f of FORMATS) {
      const box = this.q(`.ex-fmt[data-fmt="${f.key}"]`);
      const fs = s[f.key];
      box.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((i) => {
        const v = fs[i.dataset.k as keyof FmtSettings];
        if (i.type === "checkbox") i.checked = !!v;
        else i.value = String(v);
      });
    }
    this.q<HTMLInputElement>("#ex-srgb").checked = s.toSrgb;
    this.q<HTMLInputElement>("#ex-icc").checked = s.embedIcc;
    this.q<HTMLInputElement>("#ex-copyright").value = s.copyright;
    this.syncDisabled();
  }

  private read() {
    const s = this.s;
    const same = this.el.querySelector<HTMLInputElement>('input[name="ex-dest"][value="same"]')!;
    s.sameDir = same.checked;
    for (const f of FORMATS) {
      const box = this.q(`.ex-fmt[data-fmt="${f.key}"]`);
      const fs = s[f.key];
      box.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((i) => {
        const k = i.dataset.k as keyof FmtSettings;
        if (i.type === "checkbox") (fs[k] as boolean) = i.checked;
        else {
          const n = Math.max(0, Math.round(Number(i.value) || 0));
          (fs[k] as number) = k === "quality" ? Math.min(12, n) : n;
        }
      });
    }
    s.toSrgb = this.q<HTMLInputElement>("#ex-srgb").checked;
    s.embedIcc = this.q<HTMLInputElement>("#ex-icc").checked;
    s.copyright = this.q<HTMLInputElement>("#ex-copyright").value;
    save(s);
    this.syncDisabled();
  }

  /** 沒勾選的格式，其他欄位變灰（與 Photoshop 一樣） */
  private syncDisabled() {
    for (const f of FORMATS) {
      const box = this.q(`.ex-fmt[data-fmt="${f.key}"]`);
      const fs = this.s[f.key];
      box.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((i) => {
        const k = i.dataset.k;
        if (k === "on") return;
        i.disabled = this.running || !fs.on || ((k === "w" || k === "h") && !fs.resize);
      });
      box.classList.toggle("off", !fs.on);
    }
  }

  private async pickDest() {
    const d = await openDialog({ directory: true, title: "儲存已處理影像的位置", defaultPath: this.s.dest || this.host.currentDir() || undefined });
    if (typeof d !== "string") return;
    this.s.dest = d;
    this.s.sameDir = false;
    save(this.s);
    this.fill();
  }

  private status(t: string) {
    this.q("#ex-status").textContent = t;
  }

  private options(): ExportOptions | string {
    const s = this.s;
    const formats = FORMATS.filter((f) => s[f.key].on).map((f) => {
      const fs = s[f.key];
      return {
        format: f.key,
        fit: fs.resize ? ([fs.w, fs.h] as [number, number]) : null,
        quality: fs.quality,
        lzw: fs.lzw,
      };
    });
    if (!formats.length) return "請至少勾選一種檔案類型";
    if (formats.some((f) => f.fit && !f.fit[0] && !f.fit[1])) return "請填入要調整的寬度或高度";
    if (!s.sameDir && !s.dest) return "請選取儲存的資料夾";
    return { dest: s.sameDir ? null : s.dest, formats, to_srgb: s.toSrgb, embed_icc: s.embedIcc, copyright: s.copyright };
  }

  private cancel() {
    if (this.running) {
      void api.exportCancel();
      this.status("正在停止…（處理中的照片完成後停止）");
      return;
    }
    this.close();
  }

  private async run() {
    if (this.running) return;
    this.read();
    const opts = this.options();
    if (typeof opts === "string") return this.status(opts);
    this.running = true;
    this.syncDisabled();
    const runBtn = this.q<HTMLButtonElement>("#ex-run");
    const cancelBtn = this.q<HTMLButtonElement>("#ex-cancel");
    runBtn.disabled = true;
    cancelBtn.textContent = "停止";
    this.status(`轉存中… 0 / ${this.ids.length}`);
    try {
      const r = await api.exportImages(this.host.session(), this.ids, opts);
      this.running = false;
      this.close();
      this.host.done(r);
    } catch (e) {
      this.status(`轉存失敗：${e}`);
    } finally {
      this.running = false;
      runBtn.disabled = false;
      cancelBtn.textContent = "取消";
      this.syncDisabled();
    }
  }
}
