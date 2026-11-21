// 截圖標註編輯器：在圖片上加文字、箭頭、框線、圓圈、編號、星等貼紙，存成 PNG 或拷貝到剪貼簿。
// 標註以「原圖像素」記錄，畫面上縮放顯示；存檔時以原尺寸重畫，畫質不會變差。

export interface AnnotatorHost {
  /** 存成 PNG（base64）到目前的資料夾，回傳完整路徑 */
  save(name: string, pngBase64: string): Promise<string>;
  /** 拷貝到剪貼簿 */
  copy(pngBase64: string): Promise<void>;
  saved(path: string): void;
  closed(): void;
  toast(msg: string): void;
}

type Tool = "select" | "text" | "arrow" | "rect" | "ellipse" | "num" | "stars";

type Ann =
  | { kind: "text"; x: number; y: number; text: string; color: string; size: number; bold: boolean; bg: boolean; bga?: number }
  | { kind: "arrow" | "rect" | "ellipse"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: "num"; x: number; y: number; n: number; color: string; size: number }
  | { kind: "stars"; x: number; y: number; count: number; color: string; size: number };

const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#ffffff", "#000000"];
const FONT = `-apple-system, "PingFang TC", "Heiti TC", "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif`;

const TOOLS: [Tool, string, string][] = [
  ["select", "選取 / 移動（V）", `<path d="M5 3l14 8-6 2-2 6z" fill="currentColor"/>`],
  ["text", "文字（T）", `<path d="M5 5h14M12 5v14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`],
  ["arrow", "箭頭（A）", `<path d="M5 19L18 6M10 6h8v8" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`],
  ["rect", "框線（R）", `<rect x="4" y="6" width="16" height="12" rx="1.5" stroke="currentColor" stroke-width="2.2" fill="none"/>`],
  ["ellipse", "圓圈（O）", `<ellipse cx="12" cy="12" rx="8" ry="6" stroke="currentColor" stroke-width="2.2" fill="none"/>`],
  ["num", "編號貼紙（N）：每點一次 ①②③…", `<circle cx="12" cy="12" r="8" fill="currentColor"/><text x="12" y="16" font-size="11" text-anchor="middle" fill="#222" font-weight="700">1</text>`],
  ["stars", "星等貼紙（S）", `<path d="M12 3l2.6 5.6 6 .6-4.5 4 1.3 6L12 16.2 6.6 19.2l1.3-6-4.5-4 6-.6z" fill="currentColor"/>`],
];

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function circled(n: number) {
  return String(n);
}

export class Annotator {
  private root: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private img: HTMLImageElement | null = null;
  private anns: Ann[] = [];
  private history: string[] = [];
  private future: string[] = [];
  private tool: Tool = "text";
  private color = COLORS[0];
  /** 文字 / 貼紙大小、線條粗細（相對於圖片寬度的比例 × 1000） */
  private size = 30;
  private bold = true;
  private bg = true;
  /** 文字底色的不透明度（0–100） */
  private bgAlpha = 70;
  /** 最後一次儲存時的標註內容（關閉時比對，有改動就提醒存檔） */
  private savedState = "[]";
  private starCount = 5;
  private sel = -1;
  private drag: { mode: "draw" | "move"; x0: number; y0: number; orig?: Ann } | null = null;
  private editor: HTMLTextAreaElement | null = null;
  private editIndex = -1;
  private baseName = "截圖";
  isOpen = false;

  constructor(private host: AnnotatorHost) {
    this.root = document.createElement("div");
    this.root.id = "annotator";
    this.root.className = "annotator hidden";
    document.body.appendChild(this.root);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("resize", () => this.isOpen && this.render());
  }

  /** 打開圖片（blob: 網址）開始標註 */
  async open(src: string, baseName: string) {
    const img = new Image();
    img.src = src;
    try {
      await img.decode();
    } catch {
      return this.host.toast("無法開啟這張圖片");
    }
    this.img = img;
    this.anns = [];
    this.history = [];
    this.future = [];
    this.sel = -1;
    this.savedState = "[]";
    this.baseName = baseName;
    this.build();
    this.isOpen = true;
    this.root.classList.remove("hidden");
    this.root.focus();
    requestAnimationFrame(() => this.render());
  }

  /** 關閉；有尚未儲存的標註時先詢問 */
  requestClose() {
    if (!this.isOpen) return;
    this.commitText();
    if (JSON.stringify(this.anns) !== this.savedState && this.anns.length) {
      this.q(".an-confirm").classList.remove("hidden");
      this.q<HTMLButtonElement>('[data-confirm="save"]').focus();
      return;
    }
    this.close();
  }

  close() {
    if (!this.isOpen) return;
    this.commitText();
    this.isOpen = false;
    this.root.classList.add("hidden");
    this.root.innerHTML = "";
    if (this.img?.src.startsWith("blob:")) URL.revokeObjectURL(this.img.src);
    this.img = null;
    this.host.closed();
  }

  // ---------------------------------------------------------------- 介面

  private build() {
    const tools = TOOLS.map(
      ([t, title, svg]) => `<button class="an-tool${t === this.tool ? " on" : ""}" data-tool="${t}" title="${title}"><svg viewBox="0 0 24 24" width="18" height="18">${svg}</svg></button>`,
    ).join("");
    const colors = COLORS.map((c) => `<button class="an-color${c === this.color ? " on" : ""}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("");
    this.root.tabIndex = -1;
    this.root.innerHTML = `
      <div class="an-bar">
        <div class="an-group">${tools}</div>
        <div class="an-group">${colors}<label class="an-custom" title="自訂顏色"><input type="color" data-f="color" value="${this.color}"></label></div>
        <div class="an-group">
          <label class="an-size" title="大小 / 粗細">大小 <input type="range" data-f="size" min="8" max="120" value="${this.size}"></label>
          <button class="an-toggle${this.bold ? " on" : ""}" data-toggle="bold" title="粗體"><b>B</b></button>
          <button class="an-toggle${this.bg ? " on" : ""}" data-toggle="bg" title="文字底色（在照片上也看得清楚）">底色</button>
          <label class="an-size" title="文字底色的不透明度（0 = 全透明）">透明度 <input type="range" data-f="bga" min="0" max="100" value="${this.bgAlpha}"><span data-f="bga-v">${this.bgAlpha}%</span></label>
          <label class="an-stars" title="星等貼紙的星星數">★ <select data-f="stars">${[1, 2, 3, 4, 5].map((n) => `<option${n === this.starCount ? " selected" : ""}>${n}</option>`).join("")}</select></label>
        </div>
        <div class="an-group">
          <button data-act="undo" title="復原（⌘Z）">↶</button>
          <button data-act="redo" title="重做（⇧⌘Z）">↷</button>
          <button data-act="delete" title="刪除選取的標註（delete）">刪除</button>
        </div>
        <span class="an-flex"></span>
        <div class="an-group">
          <button data-act="copy" title="拷貝到剪貼簿，可以直接貼到 LINE / Email（⌘C）">拷貝</button>
          <button data-act="save" class="primary" title="存成 PNG 到目前的資料夾（⌘S）">儲存</button>
          <button data-act="close" title="關閉（Esc）；有未儲存的標註會先詢問">關閉</button>
        </div>
      </div>
      <div class="an-stage"><canvas></canvas>
        <div class="an-confirm hidden"><span>標註還沒有儲存，要儲存嗎？</span>
          <button data-confirm="save" class="primary">儲存</button><button data-confirm="discard">不儲存</button><button data-confirm="cancel">取消</button></div>
      </div>
      <div class="an-hint">文字：點一下開始打字（Enter 換行，點旁邊結束）· 選取工具可拖曳移動、雙擊文字修改 · ⌘Z 復原</div>`;
    this.canvas = this.root.querySelector("canvas")!;
    this.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.addEventListener("click", () => this.setTool(b.dataset.tool as Tool)));
    this.root.querySelectorAll<HTMLElement>("[data-color]").forEach((b) => b.addEventListener("click", () => this.setColor(b.dataset.color!)));
    this.q<HTMLInputElement>('[data-f="color"]').addEventListener("input", (e) => this.setColor((e.target as HTMLInputElement).value));
    this.q<HTMLInputElement>('[data-f="size"]').addEventListener("input", (e) => this.setSize(Number((e.target as HTMLInputElement).value)));
    this.q<HTMLSelectElement>('[data-f="stars"]').addEventListener("change", (e) => {
      this.starCount = Number((e.target as HTMLSelectElement).value);
      const a = this.anns[this.sel];
      if (a?.kind === "stars") this.change(() => (a.count = this.starCount));
      this.setTool("stars");
    });
    this.root.querySelectorAll<HTMLElement>("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.toggle as "bold" | "bg";
        this[k] = !this[k];
        b.classList.toggle("on", this[k]);
        const a = this.anns[this.sel];
        if (a?.kind === "text") this.change(() => (a[k] = this[k]));
        if (this.editor) this.styleEditor();
      }),
    );
    this.root.querySelectorAll<HTMLElement>("[data-act]").forEach((b) =>
      b.addEventListener("click", () => {
        const a = b.dataset.act;
        if (a === "undo") this.undo();
        else if (a === "redo") this.redo();
        else if (a === "delete") this.deleteSel();
        else if (a === "save") void this.save();
        else if (a === "copy") void this.copy();
        else if (a === "close") this.requestClose();
      }),
    );
    this.q<HTMLInputElement>('[data-f="bga"]').addEventListener("input", (e) => {
      this.bgAlpha = Number((e.target as HTMLInputElement).value);
      this.q('[data-f="bga-v"]').textContent = `${this.bgAlpha}%`;
      const a = this.anns[this.sel];
      if (a?.kind === "text") this.change(() => (a.bga = this.bgAlpha / 100));
      if (this.editor) this.styleEditor();
    });
    this.root.querySelectorAll<HTMLElement>("[data-confirm]").forEach((b) =>
      b.addEventListener("click", async () => {
        const c = b.dataset.confirm;
        this.q(".an-confirm").classList.add("hidden");
        if (c === "save") {
          if (await this.save()) this.close();
        } else if (c === "discard") this.close();
        else this.root.focus();
      }),
    );
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("dblclick", (e) => {
      const [x, y] = this.toImg(e);
      const i = this.hit(x, y);
      if (i >= 0 && this.anns[i].kind === "text") this.editText(i);
    });
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T;
  }

  private setTool(t: Tool) {
    this.commitText();
    this.tool = t;
    this.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
    this.canvas.style.cursor = t === "select" ? "default" : t === "text" ? "text" : "crosshair";
  }

  private setColor(c: string) {
    this.color = c;
    this.root.querySelectorAll<HTMLElement>("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === c));
    this.q<HTMLInputElement>('[data-f="color"]').value = c.length === 7 ? c : "#ff3b30";
    const a = this.anns[this.sel];
    if (a) this.change(() => (a.color = c));
    if (this.editor) this.styleEditor();
  }

  private setSize(v: number) {
    this.size = v;
    const a = this.anns[this.sel];
    if (a) {
      this.change(() => {
        if ("size" in a) a.size = this.px(v);
        else a.width = this.lineW(v);
      });
    }
    if (this.editor) this.styleEditor();
  }

  /** 大小滑桿 → 原圖像素（文字 / 貼紙） */
  private px(v = this.size) {
    return Math.max(8, Math.round((v / 1000) * (this.img?.naturalWidth ?? 1000) * 1.2));
  }

  private lineW(v = this.size) {
    return Math.max(2, Math.round(this.px(v) / 7));
  }

  // ---------------------------------------------------------------- 座標

  private view() {
    const img = this.img!;
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const s = Math.min((r.width - 32) / img.naturalWidth, (r.height - 32) / img.naturalHeight, 1.5);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    return { s, ox: (r.width - w) / 2, oy: (r.height - h) / 2, cw: r.width, ch: r.height };
  }

  private toImg(e: MouseEvent): [number, number] {
    const v = this.view();
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left - v.ox) / v.s, (e.clientY - r.top - v.oy) / v.s];
  }

  // ---------------------------------------------------------------- 繪製

  private render() {
    if (!this.img) return;
    const v = this.view();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(v.cw * dpr);
    this.canvas.height = Math.round(v.ch * dpr);
    this.canvas.style.width = `${v.cw}px`;
    this.canvas.style.height = `${v.ch}px`;
    const g = this.canvas.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(v.s * dpr, 0, 0, v.s * dpr, v.ox * dpr, v.oy * dpr);
    g.shadowColor = "#0008";
    g.shadowBlur = 18 / v.s;
    g.drawImage(this.img, 0, 0);
    g.shadowBlur = 0;
    this.anns.forEach((a, i) => {
      if (i === this.editIndex) return;
      drawAnn(g, a);
    });
    const a = this.anns[this.sel];
    if (a && this.sel !== this.editIndex) {
      const b = bbox(g, a);
      g.save();
      g.setLineDash([6 / v.s, 4 / v.s]);
      g.lineWidth = 1.5 / v.s;
      g.strokeStyle = "#0a84ff";
      g.strokeRect(b.x - 6 / v.s, b.y - 6 / v.s, b.w + 12 / v.s, b.h + 12 / v.s);
      g.restore();
    }
  }

  // ---------------------------------------------------------------- 編輯

  private snapshot() {
    this.history.push(JSON.stringify(this.anns));
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }

  private change(fn: () => void) {
    this.snapshot();
    fn();
    this.render();
  }

  private undo() {
    this.commitText();
    const prev = this.history.pop();
    if (prev === undefined) return;
    this.future.push(JSON.stringify(this.anns));
    this.anns = JSON.parse(prev);
    this.sel = -1;
    this.render();
  }

  private redo() {
    const next = this.future.pop();
    if (next === undefined) return;
    this.history.push(JSON.stringify(this.anns));
    this.anns = JSON.parse(next);
    this.sel = -1;
    this.render();
  }

  private deleteSel() {
    if (this.sel < 0) return;
    this.change(() => this.anns.splice(this.sel, 1));
    this.sel = -1;
    this.render();
  }

  private hit(x: number, y: number): number {
    const g = this.canvas.getContext("2d")!;
    const pad = 10 / this.view().s;
    for (let i = this.anns.length - 1; i >= 0; i--) {
      const b = bbox(g, this.anns[i]);
      if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return i;
    }
    return -1;
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 || !this.img) return;
    const [x, y] = this.toImg(e);
    if (this.editor) {
      this.commitText();
      if (this.tool === "text") return;
    }
    const i = this.hit(x, y);
    // 任何工具點在已有的標註上：選取並可拖曳移動（文字工具點在文字上 = 修改文字）
    if (i >= 0 && (this.tool === "select" || this.tool === "text" || e.altKey === false)) {
      if (this.tool === "text" && this.anns[i].kind === "text") return this.editText(i);
      if (this.tool === "select" || this.tool === "text") {
        this.sel = i;
        this.syncFromSel();
        this.snapshot();
        this.drag = { mode: "move", x0: x, y0: y, orig: JSON.parse(JSON.stringify(this.anns[i])) };
        this.canvas.setPointerCapture(e.pointerId);
        return this.render();
      }
    }
    this.sel = -1;
    if (this.tool === "select") return this.render();
    if (this.tool === "text") {
      this.snapshot();
      this.anns.push({ kind: "text", x, y, text: "", color: this.color, size: this.px(), bold: this.bold, bg: this.bg, bga: this.bgAlpha / 100 });
      return this.editText(this.anns.length - 1, true);
    }
    if (this.tool === "num") {
      const n = this.anns.filter((a) => a.kind === "num").length + 1;
      this.change(() => this.anns.push({ kind: "num", x, y, n, color: this.color, size: this.px() }));
      this.sel = this.anns.length - 1;
      return this.render();
    }
    if (this.tool === "stars") {
      this.change(() => this.anns.push({ kind: "stars", x, y, count: this.starCount, color: this.color === COLORS[0] ? "#ffcc00" : this.color, size: this.px() }));
      this.sel = this.anns.length - 1;
      return this.render();
    }
    this.snapshot();
    this.anns.push({ kind: this.tool, x1: x, y1: y, x2: x, y2: y, color: this.color, width: this.lineW() });
    this.sel = this.anns.length - 1;
    this.drag = { mode: "draw", x0: x, y0: y };
    this.canvas.setPointerCapture(e.pointerId);
    this.render();
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const [x, y] = this.toImg(e);
    const a = this.anns[this.sel];
    if (!a) return;
    if (d.mode === "draw" && "x2" in a) {
      a.x2 = x;
      a.y2 = y;
      if (e.shiftKey && a.kind !== "arrow") {
        // ⇧：正方形 / 正圓
        const m = Math.max(Math.abs(x - a.x1), Math.abs(y - a.y1));
        a.x2 = a.x1 + Math.sign(x - a.x1 || 1) * m;
        a.y2 = a.y1 + Math.sign(y - a.y1 || 1) * m;
      }
    } else if (d.mode === "move" && d.orig) {
      const dx = x - d.x0;
      const dy = y - d.y0;
      const o = d.orig;
      if ("x1" in o && "x1" in a) {
        a.x1 = o.x1 + dx;
        a.y1 = o.y1 + dy;
        a.x2 = o.x2 + dx;
        a.y2 = o.y2 + dy;
      } else if ("x" in o && "x" in a) {
        a.x = o.x + dx;
        a.y = o.y + dy;
      }
    }
    this.render();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!d) return;
    const a = this.anns[this.sel];
    // 只點一下沒有拖曳的線條 / 框：不留下
    if (d.mode === "draw" && a && "x2" in a && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 4) {
      this.anns.splice(this.sel, 1);
      this.history.pop();
      this.sel = -1;
    }
    if (d.mode === "move") {
      const [x, y] = this.toImg(e);
      if (Math.hypot(x - d.x0, y - d.y0) < 1) this.history.pop();
    }
    this.render();
  }

  /** 選取標註時，工具列顯示它的顏色、大小 */
  private syncFromSel() {
    const a = this.anns[this.sel];
    if (!a) return;
    this.color = a.color;
    this.root.querySelectorAll<HTMLElement>("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === a.color));
    if (a.kind === "text") {
      this.bold = a.bold;
      this.bg = a.bg;
      this.bgAlpha = Math.round((a.bga ?? 0.7) * 100);
      this.q<HTMLInputElement>('[data-f="bga"]').value = String(this.bgAlpha);
      this.q('[data-f="bga-v"]').textContent = `${this.bgAlpha}%`;
      this.root.querySelectorAll<HTMLElement>("[data-toggle]").forEach((b) => b.classList.toggle("on", this[b.dataset.toggle as "bold" | "bg"]));
    }
    // 大小滑桿換算回目前這個標註的大小
    const w = this.img?.naturalWidth ?? 1000;
    const px = "size" in a ? a.size : a.width * 7;
    this.size = Math.max(8, Math.min(120, Math.round((px / (w * 1.2)) * 1000)));
    this.q<HTMLInputElement>('[data-f="size"]').value = String(this.size);
  }

  // ---------------------------------------------------------------- 文字輸入

  private editText(i: number, fresh = false) {
    this.commitText();
    const a = this.anns[i];
    if (a?.kind !== "text") return;
    if (!fresh) this.snapshot();
    this.sel = i;
    if (!fresh) this.syncFromSel();
    this.editIndex = i;
    const ta = document.createElement("textarea");
    ta.className = "an-editor";
    ta.value = a.text;
    ta.spellcheck = false;
    this.root.querySelector(".an-stage")!.appendChild(ta);
    this.editor = ta;
    this.styleEditor();
    ta.addEventListener("input", () => this.styleEditor());
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.commitText();
      }
    });
    this.render();
    setTimeout(() => ta.focus(), 0);
  }

  private styleEditor() {
    const ta = this.editor;
    const a = this.anns[this.editIndex];
    if (!ta || a?.kind !== "text") return;
    a.color = this.color;
    a.bold = this.bold;
    a.bg = this.bg;
    a.bga = this.bgAlpha / 100;
    a.size = this.px();
    const v = this.view();
    const fs = a.size * v.s;
    ta.style.left = `${v.ox + a.x * v.s}px`;
    ta.style.top = `${v.oy + a.y * v.s}px`;
    ta.style.font = `${a.bold ? 700 : 400} ${fs}px/${1.25} ${FONT}`;
    ta.style.color = a.color;
    ta.style.background = a.bg ? bgColor(a) : "#0002";
    const lines = ta.value.split("\n");
    ta.rows = Math.max(1, lines.length);
    ta.style.width = `${Math.max(fs * 4, Math.max(...lines.map((l) => [...l].length)) * fs * 1.05 + fs)}px`;
  }

  private commitText() {
    const ta = this.editor;
    if (!ta) return;
    const i = this.editIndex;
    const a = this.anns[i];
    this.editor = null;
    this.editIndex = -1;
    ta.remove();
    if (a?.kind === "text") {
      a.text = ta.value.replace(/\s+$/, "");
      if (!a.text) {
        this.anns.splice(i, 1);
        this.sel = -1;
      }
    }
    this.render();
    this.root.focus();
  }

  // ---------------------------------------------------------------- 輸出

  private async exportPng(): Promise<string> {
    this.commitText();
    const img = this.img!;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    for (const a of this.anns) drawAnn(g, a);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("無法輸出圖片"))), "image/png"));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** 儲存成功回傳 true */
  private async save(): Promise<boolean> {
    try {
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const name = `${this.baseName}_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`;
      const path = await this.host.save(name, await this.exportPng());
      this.savedState = JSON.stringify(this.anns);
      this.host.saved(path);
      return true;
    } catch (e) {
      this.host.toast(`無法儲存：${e}`);
      return false;
    }
  }

  private async copy() {
    try {
      await this.host.copy(await this.exportPng());
      this.host.toast("已拷貝，可以到 LINE / Email 直接貼上（⌘V）");
    } catch (e) {
      this.host.toast(`無法拷貝：${e}`);
    }
  }

  private onKey(e: KeyboardEvent) {
    if (this.editor) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    e.stopPropagation();
    if (mod && k === "z") return e.preventDefault(), e.shiftKey ? this.redo() : this.undo();
    if (mod && k === "s") return e.preventDefault(), void this.save();
    if (mod && k === "c") return e.preventDefault(), void this.copy();
    if (e.key === "Escape") {
      e.preventDefault();
      if (!this.q(".an-confirm").classList.contains("hidden")) return this.q(".an-confirm").classList.add("hidden");
      return this.sel >= 0 ? ((this.sel = -1), this.render()) : this.requestClose();
    }
    if (e.key === "Delete" || e.key === "Backspace") return e.preventDefault(), this.deleteSel();
    if (mod || e.altKey) return;
    const map: Record<string, Tool> = { v: "select", t: "text", a: "arrow", r: "rect", o: "ellipse", n: "num", s: "stars" };
    if (map[k]) return e.preventDefault(), this.setTool(map[k]);
  }
}

// ---------------------------------------------------------------- 畫標註（畫面與存檔共用，座標為原圖像素）

function textLines(a: Extract<Ann, { kind: "text" }>) {
  return a.text.split("\n");
}

function bbox(g: CanvasRenderingContext2D, a: Ann): { x: number; y: number; w: number; h: number } {
  if (a.kind === "text") {
    g.save();
    g.font = `${a.bold ? 700 : 400} ${a.size}px ${FONT}`;
    const lines = textLines(a);
    const w = Math.max(a.size, ...lines.map((l) => g.measureText(l).width));
    g.restore();
    const pad = a.size * 0.3;
    return { x: a.x - pad, y: a.y - pad * 0.6, w: w + pad * 2, h: lines.length * a.size * 1.25 + pad * 1.2 };
  }
  if (a.kind === "num") return { x: a.x - a.size * 0.7, y: a.y - a.size * 0.7, w: a.size * 1.4, h: a.size * 1.4 };
  if (a.kind === "stars") {
    const w = a.size * 1.05 * a.count + a.size * 0.8;
    return { x: a.x - a.size * 0.4, y: a.y - a.size * 0.75, w, h: a.size * 1.5 };
  }
  const pad = a.width;
  return { x: Math.min(a.x1, a.x2) - pad, y: Math.min(a.y1, a.y2) - pad, w: Math.abs(a.x2 - a.x1) + pad * 2, h: Math.abs(a.y2 - a.y1) + pad * 2 };
}

/** 文字底色：淺色字配黑底、深色字配白底，透明度依設定 */
function bgColor(a: Extract<Ann, { kind: "text" }>) {
  const alpha = Math.max(0, Math.min(1, a.bga ?? 0.7));
  return luminance(a.color) > 0.55 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function starPath(g: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + rr * Math.cos(ang);
    const y = cy + rr * Math.sin(ang);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
}

function drawAnn(g: CanvasRenderingContext2D, a: Ann) {
  g.save();
  if (a.kind === "text") {
    g.font = `${a.bold ? 700 : 400} ${a.size}px ${FONT}`;
    g.textBaseline = "top";
    const lines = textLines(a);
    if (a.bg) {
      const b = bbox(g, a);
      g.fillStyle = bgColor(a);
      roundRect(g, b.x, b.y, b.w, b.h, a.size * 0.25);
      g.fill();
    } else {
      g.shadowColor = luminance(a.color) > 0.55 ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.8)";
      g.shadowBlur = a.size * 0.15;
    }
    g.fillStyle = a.color;
    lines.forEach((l, i) => g.fillText(l, a.x, a.y + i * a.size * 1.25));
  } else if (a.kind === "num") {
    const r = a.size * 0.7;
    g.fillStyle = a.color;
    g.shadowColor = "rgba(0,0,0,0.45)";
    g.shadowBlur = r * 0.3;
    g.beginPath();
    g.arc(a.x, a.y, r, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = Math.max(2, r * 0.12);
    g.strokeStyle = "#fff";
    g.stroke();
    g.fillStyle = luminance(a.color) > 0.55 ? "#111" : "#fff";
    g.font = `700 ${a.size * 0.85}px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(circled(a.n), a.x, a.y + a.size * 0.04);
  } else if (a.kind === "stars") {
    const b = bbox(g, a);
    g.fillStyle = "rgba(0,0,0,0.6)";
    roundRect(g, b.x, b.y, b.w, b.h, b.h / 2);
    g.fill();
    g.fillStyle = a.color;
    g.beginPath();
    for (let i = 0; i < a.count; i++) starPath(g, a.x + a.size * 0.5 + i * a.size * 1.05, a.y, a.size * 0.5);
    g.fill();
  } else {
    g.strokeStyle = a.color;
    g.fillStyle = a.color;
    g.lineWidth = a.width;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.shadowColor = "rgba(0,0,0,0.4)";
    g.shadowBlur = a.width * 0.8;
    if (a.kind === "rect") {
      g.strokeRect(Math.min(a.x1, a.x2), Math.min(a.y1, a.y2), Math.abs(a.x2 - a.x1), Math.abs(a.y2 - a.y1));
    } else if (a.kind === "ellipse") {
      g.beginPath();
      g.ellipse((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2, Math.abs(a.x2 - a.x1) / 2, Math.abs(a.y2 - a.y1) / 2, 0, 0, Math.PI * 2);
      g.stroke();
    } else {
      const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
      const head = Math.max(a.width * 4, 14);
      const bx = a.x2 - head * 0.8 * Math.cos(ang);
      const by = a.y2 - head * 0.8 * Math.sin(ang);
      g.beginPath();
      g.moveTo(a.x1, a.y1);
      g.lineTo(bx, by);
      g.stroke();
      g.beginPath();
      g.moveTo(a.x2, a.y2);
      g.lineTo(a.x2 - head * Math.cos(ang - 0.45), a.y2 - head * Math.sin(ang - 0.45));
      g.lineTo(a.x2 - head * Math.cos(ang + 0.45), a.y2 - head * Math.sin(ang + 0.45));
      g.closePath();
      g.fill();
    }
  }
  g.restore();
}

