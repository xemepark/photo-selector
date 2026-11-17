// 虛擬化縮圖格：不管資料夾有幾萬張，DOM 裡永遠只有「畫面上 + 上下各兩列」的格子，
// 捲動時重複利用這些格子（object pool），並把目前可見的項目回報給後端，
// 讓後端取消已經捲出畫面的縮圖工作。

import { Item, Meta, url, stars, labelColor } from "./api";
import { setImg, clearImg } from "./imgload";

export interface GridHost {
  session(): number;
  view(): Item[];
  meta(id: number): Meta | undefined;
  isSelected(id: number): boolean;
  focusId(): number | null;
  /** 選片問題標籤（HTML） */
  badges(id: number): string;
  onCellClick(index: number, ev: MouseEvent): void;
  onCellOpen(index: number): void;
  onViewport(ids: number[]): void;
}

interface Cell {
  root: HTMLDivElement;
  frame: HTMLDivElement;
  img: HTMLImageElement;
  stars: HTMLSpanElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
  badges: HTMLDivElement;
  id: number; // 綁定的 item id，-1 = 未使用
  index: number;
  /** 套用位置時的版面版本；版面改變（縮圖大小、視窗寬度）後要重新排位 */
  geo: number;
  retry: number;
  /** 看門狗：在畫面上卻遲遲沒載入完成時重新要求 */
  watch: number;
  timer: number;
}

const PAD = 6;
const GAP = 4;
const CAPTION = 16; // 檔名列高度
const CELL_CHROME = 3 * 2 + 2 * 2; // padding + border

export class Grid {
  private cells = new Map<number, Cell>();
  private pool: Cell[] = [];
  private size = 180;
  /** 縮圖框的高 / 寬：依資料夾內照片的方向決定（直幅 1.5、橫幅 0.667、混合 1） */
  private aspect = 1;
  private cols = 1;
  private cellW = 180;
  private frameH = 135;
  private rowH = 180;
  private raf = 0;
  private geo = 0;
  private lastViewportKey = "";

  constructor(
    private el: HTMLElement,
    private spacer: HTMLElement,
    private host: GridHost,
  ) {
    el.addEventListener("scroll", () => this.schedule(), { passive: true });
    new ResizeObserver(() => {
      this.layout();
      this.render();
    }).observe(el);
    el.addEventListener("mousedown", (ev) => {
      const idx = this.indexFromEvent(ev);
      if (idx !== null) this.host.onCellClick(idx, ev);
    });
    el.addEventListener("dblclick", (ev) => {
      const idx = this.indexFromEvent(ev);
      if (idx !== null) this.host.onCellOpen(idx);
    });
  }

  get columns() {
    return this.cols;
  }

  private indexFromEvent(ev: MouseEvent): number | null {
    const c = (ev.target as HTMLElement).closest(".cell") as HTMLElement | null;
    return c ? Number(c.dataset.index) : null;
  }

  setSize(px: number) {
    // 保持目前看的位置大致不變
    const firstIdx = Math.floor(Math.max(0, this.el.scrollTop - PAD) / this.rowH) * this.cols;
    this.size = px;
    this.layout();
    this.scrollToIndex(firstIdx, "top");
    this.render();
  }

  setAspect(a: number) {
    if (Math.abs(a - this.aspect) < 0.01) return;
    this.aspect = a;
    this.layout();
    this.render();
  }

  /** 項目清單（排序 / 篩選）改變時呼叫 */
  reset() {
    for (const [, c] of this.cells) this.release(c);
    this.cells.clear();
    this.layout();
    this.render();
  }

  private layout() {
    const width = this.el.clientWidth;
    this.cols = Math.max(1, Math.floor((width - PAD * 2 + GAP) / (this.size + GAP)));
    this.cellW = Math.floor((width - PAD * 2 - GAP * (this.cols - 1)) / this.cols);
    this.frameH = Math.round((this.cellW - CELL_CHROME) * this.aspect);
    this.rowH = this.frameH + CELL_CHROME + CAPTION + GAP;
    this.geo++;
    const rows = Math.ceil(this.host.view().length / this.cols);
    this.spacer.style.height = `${PAD * 2 + rows * this.rowH}px`;
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => ((this.raf = 0), this.render()));
  }

  scrollToIndex(index: number, mode: "nearest" | "top" = "nearest") {
    const row = Math.floor(index / this.cols);
    const top = PAD + row * this.rowH;
    const bottom = top + this.rowH;
    if (mode === "top") this.el.scrollTop = top - PAD;
    else if (top < this.el.scrollTop) this.el.scrollTop = top - PAD;
    else if (bottom > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = bottom - this.el.clientHeight + PAD;
  }

  render() {
    const view = this.host.view();
    const top = this.el.scrollTop;
    const h = this.el.clientHeight;
    const firstVisRow = Math.max(0, Math.floor((top - PAD) / this.rowH));
    const lastVisRow = Math.floor((top + h - PAD) / this.rowH);
    const first = Math.max(0, (firstVisRow - 2) * this.cols);
    const last = Math.min(view.length - 1, (lastVisRow + 3) * this.cols - 1);

    for (const [idx, c] of this.cells) {
      if (idx < first || idx > last || view[idx]?.id !== c.id) {
        this.release(c);
        this.cells.delete(idx);
      }
    }
    for (let i = first; i <= last; i++) {
      let c = this.cells.get(i);
      if (!c) {
        c = this.acquire();
        this.bind(c, i, view[i]);
        this.cells.set(i, c);
      } else if (c.geo !== this.geo) {
        this.place(c);
      }
      this.decorate(c);
    }

    // 回報可見範圍（多抓一列當緩衝），後端據此取消捲出畫面的工作
    const vFirst = Math.max(0, (firstVisRow - 1) * this.cols);
    const vLast = Math.min(view.length - 1, (lastVisRow + 2) * this.cols - 1);
    const key = `${this.host.session()}:${vFirst}:${vLast}:${view.length}`;
    if (key !== this.lastViewportKey) {
      this.lastViewportKey = key;
      const ids: number[] = [];
      for (let i = vFirst; i <= vLast; i++) ids.push(view[i].id);
      this.host.onViewport(ids);
    }
  }

  /** 只更新外觀（評等、選取…），不重新載入縮圖 */
  refresh() {
    for (const [, c] of this.cells) this.decorate(c);
  }

  private acquire(): Cell {
    const p = this.pool.pop();
    if (p) {
      p.root.style.display = "";
      return p;
    }
    const root = document.createElement("div");
    root.className = "cell";
    root.innerHTML = `<div class="frame"><img draggable="false" alt=""></div>
      <div class="cap"><span class="stars"></span><span class="dot"></span><span class="name"></span></div>
      <div class="badges"></div>`;
    const c: Cell = {
      root,
      frame: root.querySelector(".frame")!,
      img: root.querySelector("img")!,
      stars: root.querySelector(".stars")!,
      dot: root.querySelector(".dot")!,
      name: root.querySelector(".name")!,
      badges: root.querySelector(".badges")!,
      id: -1,
      index: -1,
      geo: -1,
      retry: 0,
      watch: 0,
      timer: 0,
    };
    c.img.addEventListener("load", () => c.img.setAttribute("data-loaded", ""));
    this.spacer.appendChild(root);
    return c;
  }

  /** 載入縮圖；後端回 410 = 排隊時被捲出畫面而取消，若現在又在畫面上就稍後重試 */
  private loadThumb(c: Cell) {
    const id = c.id;
    clearTimeout(c.watch);
    c.watch = window.setTimeout(() => {
      if (c.id === id && this.cells.get(c.index) === c && !c.img.hasAttribute("data-loaded")) {
        c.retry++;
        this.loadThumb(c);
      }
    }, 6000 + Math.min(c.retry, 5) * 2000);
    setImg(c.img, url.thumb(this.host.session(), id), () => {
      if (c.id !== id) return;
      clearTimeout(c.timer);
      c.timer = window.setTimeout(() => {
        // 只要這格還在畫面上就持續重試（不設上限）：大檔案在外接硬碟上可能要排隊很久
        if (c.id === id && this.cells.get(c.index) === c) {
          c.retry++;
          this.loadThumb(c);
        }
      }, Math.min(1500, 100 * (c.retry + 1)));
    });
  }

  private release(c: Cell) {
    clearTimeout(c.timer);
    clearTimeout(c.watch);
    c.id = -1;
    c.root.style.display = "none";
    c.img.removeAttribute("data-loaded");
    clearImg(c.img);
    this.pool.push(c);
  }

  private bind(c: Cell, index: number, item: Item) {
    c.id = item.id;
    c.index = index;
    c.retry = 0;
    c.root.dataset.index = String(index);
    this.place(c);
    c.name.textContent = item.name;
    c.root.title = item.files.join("\n");
    c.img.removeAttribute("data-loaded");
    this.loadThumb(c);
  }

  /** 依目前版面設定格子的位置與大小（不重新載入圖片） */
  private place(c: Cell) {
    const col = c.index % this.cols;
    const row = Math.floor(c.index / this.cols);
    c.root.style.transform = `translate(${PAD + col * (this.cellW + GAP)}px, ${PAD + row * this.rowH}px)`;
    c.root.style.width = `${this.cellW}px`;
    c.frame.style.height = `${this.frameH}px`;
    c.geo = this.geo;
  }

  private decorate(c: Cell) {
    const m = this.host.meta(c.id);
    const rating = m?.rating ?? 0;
    c.root.classList.toggle("selected", this.host.isSelected(c.id));
    c.root.classList.toggle("focus", this.host.focusId() === c.id);
    c.root.classList.toggle("rejected", rating < 0);
    const s = stars(rating);
    if (c.stars.textContent !== s) c.stars.textContent = s;
    c.stars.classList.toggle("rej", rating < 0);
    const col = labelColor(m?.label);
    c.dot.style.display = col ? "" : "none";
    if (col) c.dot.style.background = col;

    const view = this.host.view();
    const item = view[c.index];
    let badges = "";
    if (item?.kind === "raw+jpeg") badges += `<span class="badge">RAW+JPG</span>`;
    else if (item?.kind === "raw") badges += `<span class="badge">RAW</span>`;
    badges += this.host.badges(c.id);
    if (c.badges.innerHTML !== badges) c.badges.innerHTML = badges;
  }
}
