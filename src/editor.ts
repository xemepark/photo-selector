// 照片調整（仿 Camera Raw「基本」面板）：白平衡、曝光、對比、亮部、陰影、白色、黑色、自然飽和度、飽和度。
//
// 預覽用 WebGL 即時計算（拖曳滑桿立即看到結果）；存檔時只把數值寫進 XMP，
// 縮圖、全螢幕、影像轉存由後端用「完全相同的公式」套用（src-tauri/src/edit.rs）。
// 改公式時 shader 與 edit.rs 要一起改。

import { api, url, Item, EditParams } from "./api";

type Key = keyof EditParams;

const SLIDERS: { group: string; items: { key: Key; label: string; min: number; max: number; step: number }[] }[] = [
  {
    group: "白平衡",
    items: [
      { key: "temp", label: "色溫", min: -100, max: 100, step: 1 },
      { key: "tint", label: "色調", min: -100, max: 100, step: 1 },
    ],
  },
  {
    group: "色調",
    items: [
      { key: "exposure", label: "曝光", min: -5, max: 5, step: 0.05 },
      { key: "contrast", label: "對比", min: -100, max: 100, step: 1 },
      { key: "highlights", label: "亮部", min: -100, max: 100, step: 1 },
      { key: "shadows", label: "陰影", min: -100, max: 100, step: 1 },
      { key: "whites", label: "白色", min: -100, max: 100, step: 1 },
      { key: "blacks", label: "黑色", min: -100, max: 100, step: 1 },
    ],
  },
  {
    group: "外觀",
    items: [
      { key: "vibrance", label: "自然飽和度", min: -100, max: 100, step: 1 },
      { key: "saturation", label: "飽和度", min: -100, max: 100, step: 1 },
    ],
  },
];

export const ZERO: EditParams = {
  temp: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
};

const KEYS = Object.keys(ZERO) as Key[];

const LABEL_OF = Object.fromEntries(SLIDERS.flatMap((g) => g.items.map((s) => [s.key, s.label]))) as Record<Key, string>;

/** 上次同步時勾選的項目（預設全部） */
function loadSyncFields(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("editSyncFields") ?? "null");
    if (Array.isArray(v) && v.length) return v.filter((k) => (KEYS as string[]).includes(k));
  } catch {
    /* ignore */
  }
  return [...KEYS];
}

function saveSyncFields(f: string[]) {
  try {
    localStorage.setItem("editSyncFields", JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

export function isIdentity(p: EditParams) {
  return KEYS.every((k) => Math.abs(p[k]) < 1e-4);
}

const same = (a: EditParams, b: EditParams) => KEYS.every((k) => Math.abs(a[k] - b[k]) < 1e-4);

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
uniform vec2 u_scale;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos * u_scale, 0.0, 1.0);
}`;

// 與 edit.rs 的 pixel() / tone() 完全相同
const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_bypass;
uniform vec3 u_gains;
uniform float u_ev, u_c, u_h, u_s, u_w, u_b, u_vib, u_sat;
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
const float TAU = 6.28318530718;
float toLin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float toSrgb(float c) { c = clamp(c, 0.0, 1.0); return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float tone(float l) {
  float v = pow(max(l, 0.0), 1.0 / 2.2);
  float lo = -0.08 * u_b;
  float hi = 1.0 - 0.15 * u_w;
  v = (v - lo) / (hi - lo);
  float ws = smoothstep(0.0, 0.15, v) * (1.0 - smoothstep(0.15, 0.65, v));
  v += 0.2 * u_s * ws;
  float wh = smoothstep(0.45, 0.85, v);
  v += 0.25 * u_h * wh;
  float q = clamp(v, 0.0, 1.0);
  v -= u_c * 0.8 * sin(TAU * q) / TAU;
  return pow(max(v, 0.0), 2.2);
}
void main() {
  vec3 s = texture2D(u_tex, v_uv).rgb;
  if (u_bypass > 0.5) { gl_FragColor = vec4(s, 1.0); return; }
  float ev = exp2(u_ev);
  vec3 c = vec3(toLin(s.r), toLin(s.g), toLin(s.b)) * u_gains * ev;
  float l = dot(c, LUM);
  float l2 = tone(l);
  c = l > 1e-6 ? c * (l2 / l) : vec3(l2);
  float y = dot(c, LUM);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float s0 = mx > 1e-6 ? (mx - mn) / mx : 0.0;
  float k = (1.0 + u_sat) * (1.0 + u_vib * (1.0 - s0));
  c = max(vec3(y) + (c - vec3(y)) * k, 0.0);
  gl_FragColor = vec4(toSrgb(c.r), toSrgb(c.g), toSrgb(c.b), 1.0);
}`;

function wbGains(p: EditParams): [number, number, number] {
  const k = p.temp / 100;
  const t = p.tint / 100;
  const g = [2 ** (0.35 * k + 0.1 * t), 2 ** (-0.2 * t), 2 ** (-0.35 * k + 0.1 * t)];
  const l = g[0] * 0.2126 + g[1] * 0.7152 + g[2] * 0.0722;
  return [g[0] / l, g[1] / l, g[2] / l];
}

export interface EditorHost {
  session(): number;
  toast(msg: string): void;
  /** 存檔後通知（更新縮圖與「已調整」標記）：[id, 是否還有調整] */
  saved(results: [number, boolean][]): void;
  /** 編輯中的照片換了（讓主畫面的焦點跟著） */
  focus(id: number): void;
}

export class Editor {
  private list: Item[] = [];
  private pos = 0;
  /** 目前照片在檔案裡的設定（判斷有沒有改過） */
  private saved: EditParams = { ...ZERO };
  private p: EditParams = { ...ZERO };
  private selection: number[] = [];
  private gl: WebGLRenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private imgW = 0;
  private imgH = 0;
  private bypass = false;
  private loadSeq = 0;
  private raf = 0;
  private canvas: HTMLCanvasElement;
  private q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;

  constructor(
    private el: HTMLElement,
    private host: EditorHost,
  ) {
    el.innerHTML = this.markup();
    this.canvas = this.q<HTMLCanvasElement>("#ed-canvas");
    el.addEventListener("input", (e) => this.onInput(e));
    el.addEventListener("dblclick", (e) => {
      const k = (e.target as HTMLElement).closest<HTMLElement>("[data-reset]")?.dataset.reset as Key | undefined;
      if (k) this.set(k, 0);
    });
    this.q("#ed-reset").addEventListener("click", () => {
      this.p = { ...ZERO };
      this.syncInputs();
      this.draw();
    });
    this.q("#ed-before").addEventListener("click", () => this.toggleBefore());
    this.q("#ed-prev").addEventListener("click", () => void this.go(-1));
    this.q("#ed-next").addEventListener("click", () => void this.go(1));
    this.q("#ed-sync").addEventListener("click", () => this.openSync());
    this.q("#ed-sync-go").addEventListener("click", () => void this.syncToSelection());
    this.q("#ed-sync-cancel").addEventListener("click", () => this.q("#ed-syncbox").classList.add("hidden"));
    this.q("#ed-syncbox").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-sync-all]");
      if (b) this.onSyncChange(b as unknown as HTMLInputElement);
    });
    this.q("#ed-syncbox").addEventListener("change", (e) => this.onSyncChange(e.target as HTMLInputElement));
    this.q("#ed-cancel").addEventListener("click", () => this.close(false));
    this.q("#ed-done").addEventListener("click", () => void this.close(true));
    new ResizeObserver(() => this.draw()).observe(this.q("#ed-stage"));
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.gl = null;
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.initGl();
      void this.loadImage();
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  private markup() {
    const rows = SLIDERS.map(
      (g) => `<div class="ed-group"><h4>${g.group}</h4>${g.items
        .map(
          (s) => `<div class="ed-row">
            <label data-reset="${s.key}" title="雙擊恢復為 0">${s.label}</label>
            <input type="number" data-num="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
            <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" class="${s.key === "temp" ? "temp" : s.key === "tint" ? "tint" : ""}" />
          </div>`,
        )
        .join("")}</div>`,
    ).join("");
    return `
      <div id="ed-stage" class="ed-stage"><canvas id="ed-canvas"></canvas><div id="ed-msg" class="ed-msg"></div><div id="ed-badge" class="ed-badge hidden">原圖</div></div>
      <aside class="ed-panel">
        <div class="ed-head">
          <button id="ed-prev" title="上一張（←）">‹</button>
          <div class="ed-title"><div id="ed-name"></div><div id="ed-count" class="muted small"></div></div>
          <button id="ed-next" title="下一張（→）">›</button>
        </div>
        <div class="ed-sliders">${rows}</div>
        <div class="ed-tools">
          <button id="ed-before" title="按 \\ 切換調整前 / 調整後">調整前 / 後（\\）</button>
          <button id="ed-reset" title="全部恢復為 0">重設</button>
        </div>
        <button id="ed-sync" class="ed-sync" title="把目前的設定套用到所有選取的照片，可勾選只套用某幾項"></button>
        <div id="ed-syncbox" class="ed-syncbox hidden">
          <div id="ed-sync-title" class="ed-sync-title"></div>
          <div class="ed-sync-quick"><button data-sync-all="1" class="link">全選</button><button data-sync-all="0" class="link">全不選</button></div>
          ${SLIDERS.map(
            (g) => `<div class="ed-sync-group">
              <label class="check grp"><input type="checkbox" data-sync-group="${g.group}" /> ${g.group}</label>
              ${g.items.map((s) => `<label class="check"><input type="checkbox" data-sync="${s.key}" data-group="${g.group}" /> ${s.label}</label>`).join("")}
            </div>`,
          ).join("")}
          <p class="muted small">沒勾選的項目，每張照片保留各自原本的值。</p>
          <div class="ed-sync-actions"><button id="ed-sync-cancel">取消</button><button id="ed-sync-go" class="primary"></button></div>
        </div>
        <p class="muted small">調整不會改動原始影像，只把設定存在檔案的中繼資料裡；切換照片或按「完成」時自動儲存。拖曳到其他程式的是原檔（未調整）；要輸出調整後的照片請用「影像轉存」。</p>
        <div class="ed-foot">
          <button id="ed-cancel" title="放棄這張照片尚未儲存的變更（Esc）">取消</button>
          <button id="ed-done" class="primary" title="儲存並關閉（Enter）">完成</button>
        </div>
      </aside>`;
  }

  /** 開啟：list = 要逐張調整的照片，start = 從哪一張開始，selection = 「套用到選取」的對象 */
  async open(list: Item[], start: number, selection: number[]) {
    if (!list.length) return;
    this.list = list;
    this.pos = Math.max(0, Math.min(start, list.length - 1));
    this.selection = selection;
    this.el.classList.remove("hidden");
    if (!this.gl) this.initGl();
    if (!this.gl) {
      this.el.classList.add("hidden");
      this.host.toast("這台電腦的顯示環境不支援即時預覽（WebGL），無法開啟調整");
      return;
    }
    await this.show();
  }

  private initGl() {
    const gl = this.canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    try {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "a_pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.gl = gl;
      this.prog = prog;
    } catch (e) {
      console.warn("WebGL init failed", e);
      this.gl = null;
    }
  }

  private get item() {
    return this.list[this.pos];
  }

  private async show() {
    const it = this.item;
    this.host.focus(it.id);
    this.q("#ed-name").textContent = it.name;
    this.q("#ed-count").textContent = this.list.length > 1 ? `${this.pos + 1} / ${this.list.length}` : "";
    this.q<HTMLButtonElement>("#ed-prev").disabled = this.pos === 0;
    this.q<HTMLButtonElement>("#ed-next").disabled = this.pos >= this.list.length - 1;
    const n = this.selection.length;
    const sync = this.q<HTMLButtonElement>("#ed-sync");
    sync.textContent = `套用到所有選取的照片（${n} 張）`;
    sync.classList.toggle("hidden", n < 2);
    this.setBefore(false);
    this.q("#ed-syncbox").classList.add("hidden");
    try {
      this.saved = { ...ZERO, ...(await api.getEdit(this.host.session(), it.id)) };
    } catch {
      this.saved = { ...ZERO };
    }
    this.p = { ...this.saved };
    this.syncInputs();
    await this.loadImage();
  }

  private async loadImage() {
    const gl = this.gl;
    if (!gl) return;
    const seq = ++this.loadSeq;
    const msg = this.q("#ed-msg");
    msg.textContent = "載入中…";
    try {
      const res = await fetch(url.base(this.host.session(), this.item.id));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      if (seq !== this.loadSeq || !this.gl) return bmp.close();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bmp);
      this.imgW = bmp.width;
      this.imgH = bmp.height;
      bmp.close();
      msg.textContent = "";
      this.draw();
    } catch (e) {
      if (seq === this.loadSeq) msg.textContent = `無法載入照片：${e}`;
    }
  }

  private draw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.render());
  }

  private render() {
    const gl = this.gl;
    if (!gl || !this.prog || !this.imgW || !this.isOpen) return;
    const stage = this.q("#ed-stage");
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(stage.clientWidth * dpr));
    const ch = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0.07, 0.07, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // 等比縮放、置中（留 24px 邊）
    const pad = 24 * dpr;
    const s = Math.min((cw - pad * 2) / this.imgW, (ch - pad * 2) / this.imgH);
    const u = (k: string) => gl.getUniformLocation(this.prog!, k);
    gl.uniform2f(u("u_scale"), (this.imgW * s) / cw, (this.imgH * s) / ch);
    const p = this.p;
    const g = wbGains(p);
    gl.uniform1f(u("u_bypass"), this.bypass ? 1 : 0);
    gl.uniform3f(u("u_gains"), g[0], g[1], g[2]);
    gl.uniform1f(u("u_ev"), p.exposure);
    gl.uniform1f(u("u_c"), p.contrast / 100);
    gl.uniform1f(u("u_h"), p.highlights / 100);
    gl.uniform1f(u("u_s"), p.shadows / 100);
    gl.uniform1f(u("u_w"), p.whites / 100);
    gl.uniform1f(u("u_b"), p.blacks / 100);
    gl.uniform1f(u("u_vib"), p.vibrance / 100);
    gl.uniform1f(u("u_sat"), p.saturation / 100);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    const k = (t.dataset.key ?? t.dataset.num) as Key | undefined;
    if (!k) return;
    const v = Number(t.value);
    if (!Number.isFinite(v)) return;
    this.set(k, v, t);
  }

  private set(k: Key, v: number, from?: HTMLInputElement) {
    const lim = k === "exposure" ? 5 : 100;
    this.p[k] = Math.max(-lim, Math.min(lim, v));
    this.syncInputs(from);
    if (this.bypass) this.setBefore(false);
    this.draw();
  }

  private syncInputs(except?: HTMLInputElement) {
    for (const k of KEYS) {
      const v = this.p[k];
      const txt = k === "exposure" ? (v > 0 ? "+" : "") + v.toFixed(2) : String(Math.round(v));
      this.el.querySelectorAll<HTMLInputElement>(`[data-key="${k}"],[data-num="${k}"]`).forEach((i) => {
        if (i === except) return;
        i.value = i.type === "number" ? txt.replace("+", "") : String(v);
      });
      this.q(`[data-reset="${k}"]`).classList.toggle("changed", Math.abs(v) > 1e-4);
    }
  }

  private setBefore(on: boolean) {
    this.bypass = on;
    this.q("#ed-badge").classList.toggle("hidden", !on);
    this.q("#ed-before").classList.toggle("active", on);
    this.draw();
  }

  toggleBefore() {
    this.setBefore(!this.bypass);
  }

  private async save(ids: number[], params: EditParams, fields: string[] | null = null) {
    const r = await api.saveEdit(this.host.session(), ids, params, fields);
    if (r.failed.length) this.host.toast(`有 ${r.failed.length} 張無法儲存調整：${r.failed[0]}`);
    this.host.saved(r.edited);
  }

  /** 有改過才存 */
  private async saveCurrent() {
    if (same(this.p, this.saved)) return;
    const params = { ...this.p };
    await this.save([this.item.id], params);
    this.saved = params;
  }

  async go(delta: number) {
    const next = this.pos + delta;
    if (next < 0 || next >= this.list.length) return;
    try {
      await this.saveCurrent();
    } catch (e) {
      this.host.toast(`無法儲存調整：${e}`);
      return;
    }
    this.pos = next;
    await this.show();
  }

  /** 「套用到所有選取的照片」：先選要同步哪些項目 */
  private openSync() {
    if (this.selection.length < 2) return;
    const box = this.q("#ed-syncbox");
    const chosen = loadSyncFields();
    box.querySelectorAll<HTMLInputElement>("input[data-sync]").forEach((i) => {
      i.checked = chosen.includes(i.dataset.sync!);
    });
    this.q("#ed-sync-title").textContent = `要套用到選取的 ${this.selection.length} 張照片的項目`;
    this.updateSyncUi();
    box.classList.remove("hidden");
    box.scrollIntoView({ block: "nearest" });
  }

  private syncFields(): string[] {
    return [...this.el.querySelectorAll<HTMLInputElement>("input[data-sync]")].filter((i) => i.checked).map((i) => i.dataset.sync!);
  }

  private updateSyncUi() {
    const n = this.syncFields().length;
    const go = this.q<HTMLButtonElement>("#ed-sync-go");
    go.disabled = n === 0;
    go.textContent = n === KEYS.length ? "全部套用" : `套用勾選的 ${n} 項`;
    // 群組勾選框：全勾 / 部分 / 全不勾
    this.el.querySelectorAll<HTMLInputElement>("input[data-sync-group]").forEach((g) => {
      const items = [...this.el.querySelectorAll<HTMLInputElement>(`input[data-sync][data-group="${g.dataset.syncGroup}"]`)];
      const on = items.filter((i) => i.checked).length;
      g.checked = on === items.length;
      g.indeterminate = on > 0 && on < items.length;
    });
  }

  private onSyncChange(t: HTMLInputElement) {
    if (t.dataset.syncGroup) {
      this.el.querySelectorAll<HTMLInputElement>(`input[data-sync][data-group="${t.dataset.syncGroup}"]`).forEach((i) => (i.checked = t.checked));
    }
    if (t.dataset.syncAll !== undefined) {
      this.el.querySelectorAll<HTMLInputElement>("input[data-sync]").forEach((i) => (i.checked = t.dataset.syncAll === "1"));
    }
    this.updateSyncUi();
  }

  private async syncToSelection() {
    const ids = this.selection;
    const fields = this.syncFields();
    if (ids.length < 2 || !fields.length) return;
    saveSyncFields(fields);
    this.q("#ed-syncbox").classList.add("hidden");
    try {
      // 目前這張先完整存檔（包含沒勾選的項目），其他照片只覆寫勾選的項目
      await this.saveCurrent();
      const others = ids.filter((id) => id !== this.item.id);
      const all = fields.length === KEYS.length;
      await this.save(others, { ...this.p }, all ? null : fields);
      const names = fields.map((f) => LABEL_OF[f as Key]).join("、");
      this.host.toast(all ? `已把全部調整套用到 ${ids.length} 張照片` : `已把「${names}」套用到 ${ids.length} 張照片，其他設定保留各自的值`);
    } catch (e) {
      this.host.toast(`無法套用：${e}`);
    }
  }

  async close(save: boolean) {
    if (save) {
      try {
        await this.saveCurrent();
      } catch (e) {
        this.host.toast(`無法儲存調整：${e}`);
        return;
      }
    }
    this.loadSeq++;
    this.el.classList.add("hidden");
    // 釋放貼圖記憶體
    const gl = this.gl;
    if (gl && this.tex) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
    }
    this.imgW = 0;
  }

  /** 調整視窗開著時的按鍵（回傳 true = 已處理） */
  key(ev: KeyboardEvent): boolean {
    const t = ev.target as HTMLElement;
    // 焦點在滑桿或數字欄時，方向鍵用來微調數值
    const typing = t.tagName === "INPUT";
    if (ev.key === "Escape") {
      const box = this.q("#ed-syncbox");
      if (!box.classList.contains("hidden")) return box.classList.add("hidden"), true;
      return void this.close(false), true;
    }
    if (ev.key === "Enter" && !typing) return void this.close(true), true;
    if (typing) return false;
    if (ev.key === "\\") return this.toggleBefore(), true;
    if (ev.key === "ArrowLeft") return void this.go(-1), true;
    if (ev.key === "ArrowRight") return void this.go(1), true;
    return true; // 其他按鍵不傳到背後的主畫面（避免誤評分）
  }
}
