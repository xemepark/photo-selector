// 虛擬化縮圖格：不管資料夾有幾萬張，DOM 裡永遠只有「畫面上 + 上下各兩列」的格子，
// 捲動時重複利用這些格子（object pool），並把目前可見的項目回報給後端，
// 讓後端取消已經捲出畫面的縮圖工作。

import { Item, Meta, DirInfo, url, stars, labelColor } from "./api";
import { setImg, clearImg, imageMode } from "./imgload";

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
  onCellMenu(index: number, ev: MouseEvent): void;
  /** 在格子上按住滑鼠並拖動超過一小段距離：開始拖曳到其他程式 */
  onCellDrag(index: number): void;
  /** 在格子上按下又放開、中間沒有變成拖曳 */
  onCellUp(index: number): void;
  onViewport(ids: number[]): void;
  /** 排序 / 篩選後的完整順序（後端依此在背景預先產生縮圖） */
  onOrder?(ids: number[]): void;
  /** 資料夾格子：按兩下開啟、右鍵、按住拖曳 */
  onFolderOpen?(path: string): void;
  onFolderMenu?(path: string, ev: MouseEvent): void;
  onFolderDrag?(path: string, name: string, down: MouseEvent): void;
  /** 選取的資料夾改變（"" = 沒有選資料夾） */
  onFolderSelect?(path: string): void;
}

const FOLDER_SVG = `<svg viewBox="0 0 64 52" class="folder-ico" aria-hidden="true"><path d="M4 8a4 4 0 0 1 4-4h15l6 6h27a4 4 0 0 1 4 4v30a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="#5b8fd6"/><path d="M4 17a4 4 0 0 1 4-4h48a4 4 0 0 1 4 4v27a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="#79a9ea"/></svg>`;

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
  /** 載入序號（快速小縮圖 → 正式縮圖，舊的結果作廢用） */
  seq: number;
  /** 正式縮圖已顯示（不是快速小縮圖） */
  full: boolean;
  /** 正式縮圖的預先載入 */
  pre: HTMLImageElement | null;
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
  private lastOrderView: Item[] | null = null;
  private lastOrderSession = -1;
  /** 目前資料夾裡的子資料夾：排在所有照片前面（格子位置 0…nf-1） */
  private folders: DirInfo[] = [];
  private fcells = new Map<number, HTMLDivElement>();
  private selFolder = "";

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
      const f = this.folderFromEvent(ev);
      if (f) {
        this.selectFolder(f.path);
        if (ev.button === 0) this.host.onFolderDrag?.(f.path, f.name, ev);
        return;
      }
      if (this.selFolder) this.selectFolder("");
      const idx = this.indexFromEvent(ev);
      if (idx === null) return;
      this.host.onCellClick(idx, ev);
      if (ev.button === 0 && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) this.trackPress(idx, ev);
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const f = this.folderFromEvent(ev);
      if (f) return void this.host.onFolderMenu?.(f.path, ev);
      const idx = this.indexFromEvent(ev);
      if (idx !== null) this.host.onCellMenu(idx, ev);
    });
    el.addEventListener("dblclick", (ev) => {
      const f = this.folderFromEvent(ev);
      if (f) return void this.host.onFolderOpen?.(f.path);
      const idx = this.indexFromEvent(ev);
      if (idx !== null) this.host.onCellOpen(idx);
    });
  }

  /** 按下後追蹤滑鼠：移動超過 6px 就交給 host 開始系統拖曳；放開時通知 host */
  private trackPress(idx: number, down: MouseEvent) {
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (moved) return;
      if ((ev.buttons & 1) === 0) return up();
      if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 6) return;
      moved = true;
      // 系統拖曳開始後，放開滑鼠的事件不一定會回到這個視窗，所以這裡就先收掉監聽
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      this.host.onCellDrag(idx);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!moved) this.host.onCellUp(idx);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  get columns() {
    return this.cols;
  }

  private indexFromEvent(ev: MouseEvent): number | null {
    const c = (ev.target as HTMLElement).closest(".cell:not(.folder-cell)") as HTMLElement | null;
    return c ? Number(c.dataset.index) : null;
  }

  private folderFromEvent(ev: MouseEvent): DirInfo | null {
    const c = (ev.target as HTMLElement).closest(".folder-cell") as HTMLElement | null;
    return c ? (this.folders[Number(c.dataset.folder)] ?? null) : null;
  }

  private get nf() {
    return this.folders.length;
  }

  /** 設定要顯示的子資料夾（有變才重排） */
  setFolders(list: DirInfo[]) {
    const same = list.length === this.folders.length && list.every((d, i) => d.path === this.folders[i].path);
    if (same) {
      // 同一組資料夾：只更新評等 / 標籤
      this.folders = list;
      for (const [i, el] of this.fcells) this.decorateFolder(el, this.folders[i]);
      return;
    }
    if (this.selFolder && !list.some((d) => d.path === this.selFolder)) this.selectFolder("");
    this.folders = list;
    for (const [, el] of this.fcells) el.remove();
    this.fcells.clear();
    this.reset();
  }

  /** 反白某個資料夾格子並捲到它（新增資料夾後） */
  highlightFolder(path: string) {
    this.selectFolder(path);
    const i = this.folders.findIndex((d) => d.path === path);
    if (i >= 0) this.scrollToPos(i, "nearest");
    this.render();
  }

  get selectedFolder() {
    return this.selFolder;
  }

  selectFolder(path: string) {
    const changed = path !== this.selFolder;
    this.selFolder = path;
    if (changed) this.host.onFolderSelect?.(path);
    for (const [i, el] of this.fcells) el.classList.toggle("selected", this.folders[i]?.path === path);
  }

  setSize(px: number) {
    // 保持目前看的位置大致不變
    const firstPos = Math.floor(Math.max(0, this.el.scrollTop - PAD) / this.rowH) * this.cols;
    this.size = px;
    this.layout();
    this.scrollToPos(firstPos, "top");
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
    const rows = Math.ceil((this.nf + this.host.view().length) / this.cols);
    this.spacer.style.height = `${PAD * 2 + rows * this.rowH}px`;
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => ((this.raf = 0), this.render()));
  }

  scrollToIndex(index: number, mode: "nearest" | "top" = "nearest") {
    this.scrollToPos(index + this.nf, mode);
  }

  private scrollToPos(pos: number, mode: "nearest" | "top") {
    const row = Math.floor(pos / this.cols);
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
    // 格子位置 = 資料夾（0…nf-1）+ 照片（nf…）；cells 的鍵是照片在 view 裡的索引
    const nf = this.nf;
    const firstPos = Math.max(0, (firstVisRow - 2) * this.cols);
    const lastPos = (lastVisRow + 3) * this.cols - 1;
    const first = Math.max(0, firstPos - nf);
    const last = Math.min(view.length - 1, lastPos - nf);
    this.renderFolders(firstPos, Math.min(lastPos, nf - 1));

    for (const [idx, c] of this.cells) {
      if (idx < first || idx > last || view[idx]?.id !== c.id) {
        this.release(c);
        this.cells.delete(idx);
      }
    }
    // 先處理畫面上看得到的格子（由左上到右下），再處理上下的緩衝列：縮圖會依這個順序產生
    const visStart = Math.min(Math.max(first, firstVisRow * this.cols - nf), last + 1);
    const order: number[] = [];
    for (let i = visStart; i <= last; i++) order.push(i);
    for (let i = first; i < visStart; i++) order.push(i);
    if (view !== this.lastOrderView || this.host.session() !== this.lastOrderSession) {
      this.lastOrderView = view;
      this.lastOrderSession = this.host.session();
      this.host.onOrder?.(view.map((it) => it.id));
    }
    for (const i of order) {
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
    const vFirst = Math.max(0, (firstVisRow - 1) * this.cols - nf);
    const vLast = Math.min(view.length - 1, (lastVisRow + 2) * this.cols - 1 - nf);
    // key 要包含實際的 id：改變排序 / 篩選後，同一段範圍內的照片不同，必須重新回報，
    // 否則後端會以為新出現的照片不在畫面上而一直取消（縮圖留白）
    const ids: number[] = [];
    for (let i = vFirst; i <= vLast; i++) ids.push(view[i].id);
    const key = `${this.host.session()}:${ids.join(",")}`;
    if (key !== this.lastViewportKey) {
      this.lastViewportKey = key;
      this.host.onViewport(ids);
    }
  }

  /** 資料夾格子（數量通常不多，直接建立 / 移除） */
  private renderFolders(from: number, to: number) {
    for (const [i, el] of this.fcells) {
      if (i < from || i > to) {
        el.remove();
        this.fcells.delete(i);
      }
    }
    for (let i = from; i <= to; i++) {
      const d = this.folders[i];
      if (!d) continue;
      let el = this.fcells.get(i);
      if (!el) {
        el = document.createElement("div");
        el.className = "cell folder-cell";
        el.dataset.folder = String(i);
        el.dataset.path = d.path;
        el.title = `${d.path}\n按兩下開啟；拖到分頁列的「＋」用新分頁開啟`;
        el.innerHTML = `<div class="frame">${FOLDER_SVG}</div><div class="cap"><span class="stars"></span><span class="dot"></span><span class="name"></span></div>`;
        el.querySelector(".name")!.textContent = d.name;
        this.spacer.appendChild(el);
        this.fcells.set(i, el);
        el.dataset.geo = "";
      }
      el.classList.toggle("selected", d.path === this.selFolder);
      this.decorateFolder(el, d);
      if (el.dataset.geo !== String(this.geo)) {
        const col = i % this.cols;
        const row = Math.floor(i / this.cols);
        el.style.transform = `translate(${PAD + col * (this.cellW + GAP)}px, ${PAD + row * this.rowH}px)`;
        el.style.width = `${this.cellW}px`;
        (el.firstElementChild as HTMLElement).style.height = `${this.frameH}px`;
        el.dataset.geo = String(this.geo);
      }
    }
  }

  private decorateFolder(el: HTMLElement, d: DirInfo | undefined) {
    if (!d) return;
    const r = d.rating ?? 0;
    const st = el.querySelector<HTMLElement>(".stars")!;
    const s = stars(r);
    if (st.textContent !== s) st.textContent = s;
    st.classList.toggle("rej", r < 0);
    el.classList.toggle("rejected", r < 0);
    const dot = el.querySelector<HTMLElement>(".dot")!;
    const col = labelColor(d.label);
    dot.style.display = col ? "" : "none";
    if (col) dot.style.background = col;
  }

  /** 強制重新回報可見範圍（例如調整視窗關閉後，後端的可見清單被縮圖列換掉了） */
  refreshViewport() {
    this.lastViewportKey = "";
    this.schedule();
  }

  /** 重新載入縮圖（ids 省略 = 畫面上全部） */
  reloadThumbs(ids?: Set<number>) {
    for (const [, c] of this.cells) {
      if (c.id < 0 || (ids && !ids.has(c.id))) continue;
      c.retry = 0;
      // 舊縮圖先留著（不隱藏），新的在背景載好才換掉，不會先變空白
      this.loadThumb(c);
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
      seq: 0,
      full: false,
      pre: null,
    };
    c.img.addEventListener("load", () => {
      c.img.setAttribute("data-loaded", "");
      c.full = true;
      c.frame.style.backgroundImage = "";
    });
    this.spacer.appendChild(root);
    return c;
  }

  /** 載入縮圖；後端回 410 = 排隊時被捲出畫面而取消，若現在又在畫面上就稍後重試 */
  private loadThumb(c: Cell) {
    const id = c.id;
    const seq = ++c.seq;
    this.armWatch(c, id);
    // 第一次載入：先把檔案內嵌的小縮圖當成格子的背景顯示（幾乎立刻出現、略模糊），正式縮圖好了蓋在上面。
    // 小縮圖放在背景而不是 <img>：沒有小縮圖（404）時不會觸發 <img> 的錯誤處理，也不會出現破圖
    if (c.retry === 0 && !c.full && !c.img.getAttribute("src") && imageMode() === "direct") {
      c.frame.style.backgroundImage = `url("${url.quick(this.host.session(), id)}")`;
      const pre = new Image();
      c.pre = pre; // 留著參照，避免載入中被回收
      const go = () => {
        if (c.pre === pre) c.pre = null;
        if (c.id === id && c.seq === seq) this.loadFull(c, id);
      };
      pre.onload = go;
      pre.onerror = go;
      pre.src = url.thumb(this.host.session(), id);
      return;
    }
    this.loadFull(c, id);
  }

  /** 看門狗：在畫面上卻遲遲沒顯示正式縮圖時重新要求 */
  private armWatch(c: Cell, id: number) {
    clearTimeout(c.watch);
    c.watch = window.setTimeout(() => {
      if (c.id === id && this.cells.get(c.index) === c && !c.full) {
        c.retry++;
        this.loadThumb(c);
      }
    }, 6000 + Math.min(c.retry, 5) * 2000);
  }

  private loadFull(c: Cell, id: number) {
    this.armWatch(c, id);
    setImg(c.img, url.thumb(this.host.session(), id), (status) => {
      if (c.id !== id) return;
      // 410 = 後端認為不在畫面上；這格明明在畫面上，就重新回報可見範圍（保險）
      if (status === 410 && c.retry >= 2) {
        this.lastViewportKey = "";
        this.schedule();
      }
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
    c.seq++;
    c.full = false;
    c.pre = null;
    c.frame.style.backgroundImage = "";
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
    c.root.title = (item.sub ? `📁 ${item.sub}\n` : "") + item.files.join("\n");
    c.img.removeAttribute("data-loaded");
    c.full = false;
    c.frame.style.backgroundImage = "";
    this.loadThumb(c);
  }

  /** 依目前版面設定格子的位置與大小（不重新載入圖片） */
  private place(c: Cell) {
    const pos = c.index + this.nf;
    const col = pos % this.cols;
    const row = Math.floor(pos / this.cols);
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
    if (m?.edited) badges += `<span class="badge edited" title="已調整">調整</span>`;
    if (item?.cloud) badges += `<span class="badge cloud" title="還在 iCloud 上，按右鍵「從 iCloud 下載」">☁ iCloud</span>`;
    badges += this.host.badges(c.id);
    if (c.badges.innerHTML !== badges) c.badges.innerHTML = badges;
  }
}
