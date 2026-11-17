// 幻燈片播放：全螢幕輪播照片，搭配背景音樂（播放清單、音量、淡入淡出）。
//
// - 兩層 <img> 交替顯示，做出淡入淡出 / 緩慢推近（Ken Burns）轉場
// - 下一張圖片載入完成才切換，計時從「真的顯示出來」開始，不會因為慢速硬碟而跳張
// - 背景音樂：透過 Tauri 的 asset 協定讀進記憶體成為 Blob，再以 blob: 網址播放。
//   部分 WebKit（例如 Linux 的 WebKitGTK）無法直接從自訂協定串流媒體，blob: 在各平台都能播放

import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Transition = "fade" | "kenburns" | "none";

export interface SlideSettings {
  scope: "view" | "selected";
  skipRejected: boolean;
  order: "sorted" | "shuffle";
  start: "first" | "focus";
  /** 每張秒數 */
  interval: number;
  transition: Transition;
  loop: boolean;
  fullscreen: boolean;
  showInfo: boolean;
  /** 背景音樂檔案路徑（依序播放） */
  music: string[];
  volume: number;
  /** 依音樂總長度自動調整每張秒數，照片與音樂盡量同時結束 */
  fitMusic: boolean;
}

export const DEFAULT_SETTINGS: SlideSettings = {
  scope: "view",
  skipRejected: true,
  order: "sorted",
  start: "first",
  interval: 4,
  transition: "fade",
  loop: true,
  fullscreen: true,
  showInfo: false,
  music: [],
  volume: 0.8,
  fitMusic: false,
};

export interface SlideHost {
  previewUrl(id: number): string;
  /** 顯示在畫面左下的說明（HTML） */
  caption(id: number): string;
  onExit(lastId: number | null): void;
}

const FADE_MS = 1000;
const MUSIC_FADE_MS = 1500;
const MIN_INTERVAL = 2;
const MAX_INTERVAL = 30;

export function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function fmtTime(sec: number) {
  if (!isFinite(sec) || sec < 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const blobUrls = new Map<string, Promise<string>>();

/** 取得可播放的 blob: 網址（同一首只讀取一次） */
export function audioSrc(path: string): Promise<string> {
  let p = blobUrls.get(path);
  if (!p) {
    p = fetch(convertFileSrc(path))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((b) => URL.createObjectURL(b));
    p.catch(() => blobUrls.delete(path));
    blobUrls.set(path, p);
  }
  return p;
}

/** 讀取一首音樂的長度（秒）；讀不到回傳 NaN */
export async function audioDuration(path: string, timeoutMs = 8000): Promise<number> {
  let src: string;
  try {
    src = await audioSrc(path);
  } catch {
    return NaN;
  }
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = "metadata";
    const done = (v: number) => {
      clearTimeout(t);
      a.removeAttribute("src");
      resolve(v);
    };
    const t = setTimeout(() => done(NaN), timeoutMs);
    a.addEventListener("loadedmetadata", () => done(a.duration), { once: true });
    a.addEventListener("error", () => done(NaN), { once: true });
    a.src = src;
  });
}

export class Slideshow {
  active = false;
  private slides: number[] = [];
  private index = 0;
  private settings: SlideSettings = DEFAULT_SETTINGS;
  private intervalMs = 4000;
  private paused = false;
  private timer = 0;
  private token = 0;
  private front = 0;
  private layers: HTMLImageElement[];
  private caption: HTMLElement;
  private bar: HTMLElement;
  private countEl: HTMLElement;
  private trackEl: HTMLElement;
  private toggleBtn: HTMLElement;
  private volInput: HTMLInputElement;
  private audio = new Audio();
  private track = 0;
  private trackToken = 0;
  private muted = false;
  private fadeTimer = 0;
  private hideTimer = 0;
  private trackTicker = 0;
  private wentFullscreen = false;
  private prefetched: HTMLImageElement[] = [];

  constructor(
    private root: HTMLElement,
    private host: SlideHost,
  ) {
    this.layers = [...root.querySelectorAll<HTMLImageElement>(".slide-layer")];
    this.caption = root.querySelector(".slide-caption")!;
    this.bar = root.querySelector(".slide-bar")!;
    this.countEl = root.querySelector(".slide-count")!;
    this.trackEl = root.querySelector(".slide-track")!;
    this.toggleBtn = root.querySelector('[data-act="toggle"]')!;
    this.volInput = root.querySelector(".slide-vol")!;

    this.bar.addEventListener("click", (ev) => {
      const act = (ev.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
      if (act === "prev") this.prev();
      else if (act === "next") this.next();
      else if (act === "toggle") this.togglePause();
      else if (act === "mute") this.toggleMute();
      else if (act === "close") this.stop();
    });
    this.volInput.addEventListener("input", () => {
      this.settings.volume = Number(this.volInput.value);
      if (!this.fadeTimer) this.audio.volume = this.muted ? 0 : this.settings.volume;
    });
    root.addEventListener("mousemove", () => this.wake());
    this.audio.addEventListener("ended", () => this.playTrack(this.track + 1));
    this.audio.addEventListener("error", () => {
      // 這首解碼失敗（格式不支援）→ 顯示提示並跳下一首；全部失敗就安靜播放
      if (!this.active || !this.audio.getAttribute("src")) return;
      this.renderTrack(true);
      if (this.settings.music.length > 1) setTimeout(() => this.playTrack(this.track + 1), 300);
    });
  }

  currentId(): number | null {
    return this.active ? (this.slides[this.index] ?? null) : null;
  }

  /** 計算實際每張秒數（開啟「依音樂長度」時需要先讀取音樂長度） */
  static async effectiveInterval(s: SlideSettings, count: number): Promise<number> {
    if (!s.fitMusic || !s.music.length || !count) return s.interval;
    const ds = await Promise.all(s.music.map((p) => audioDuration(p)));
    const total = ds.filter((d) => isFinite(d)).reduce((a, b) => a + b, 0);
    if (!total) return s.interval;
    return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, total / count));
  }

  async start(slides: number[], settings: SlideSettings, startIndex = 0) {
    if (!slides.length) return;
    this.settings = { ...settings };
    this.slides = settings.order === "shuffle" ? shuffle(slides) : slides;
    this.index = settings.order === "shuffle" ? 0 : Math.max(0, Math.min(startIndex, slides.length - 1));
    this.intervalMs = (await Slideshow.effectiveInterval(settings, this.slides.length)) * 1000;
    // 依音樂長度模式：照片播完就結束（音樂太短會重複播放，太長則在最後淡出）
    if (settings.fitMusic && settings.music.length) this.settings.loop = false;
    this.active = true;
    this.paused = false;
    this.muted = false;
    this.root.classList.remove("hidden");
    this.root.classList.toggle("show-info", settings.showInfo);
    this.root.dataset.transition = settings.transition;
    this.layers.forEach((l) => {
      l.classList.remove("on", "kb");
      l.removeAttribute("src");
    });
    this.volInput.value = String(settings.volume);
    this.toggleBtn.textContent = "⏸";
    if (settings.fullscreen) {
      try {
        const w = getCurrentWindow();
        if (!(await w.isFullscreen())) {
          await w.setFullscreen(true);
          this.wentFullscreen = true;
        }
      } catch {
        /* 不支援就維持視窗模式 */
      }
    }
    this.root.focus();
    this.show(this.index);
    this.playTrack(0, true);
    this.wake();
  }

  async stop() {
    if (!this.active) return;
    const last = this.currentId();
    this.active = false;
    clearTimeout(this.timer);
    clearTimeout(this.hideTimer);
    clearInterval(this.trackTicker);
    this.token++;
    this.trackToken++;
    this.fadeAudio(0, 600, () => {
      this.audio.pause();
      this.audio.removeAttribute("src");
    });
    this.root.classList.add("hidden");
    this.layers.forEach((l) => l.removeAttribute("src"));
    this.prefetched = [];
    if (this.wentFullscreen) {
      this.wentFullscreen = false;
      try {
        await getCurrentWindow().setFullscreen(false);
      } catch {
        /* ignore */
      }
    }
    this.host.onExit(last);
  }

  next() {
    if (!this.active) return;
    if (this.index + 1 >= this.slides.length) {
      if (!this.settings.loop) return void this.finish();
      this.show(0);
    } else this.show(this.index + 1);
  }

  prev() {
    if (!this.active) return;
    this.show(this.index === 0 ? this.slides.length - 1 : this.index - 1);
  }

  togglePause() {
    if (!this.active) return;
    this.paused = !this.paused;
    this.toggleBtn.textContent = this.paused ? "▶" : "⏸";
    clearTimeout(this.timer);
    if (this.paused) {
      this.fadeAudio(0, 400, () => this.audio.pause());
    } else {
      this.schedule();
      if (this.audio.src) {
        this.audio.play().catch(() => {});
        this.fadeAudio(this.targetVolume(), 400);
      }
    }
    this.root.classList.toggle("paused", this.paused);
    this.wake();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.audio.volume = this.targetVolume();
    this.root.querySelector('[data-act="mute"]')!.textContent = this.muted ? "🔇" : "🔊";
    this.wake();
  }

  toggleInfo() {
    this.root.classList.toggle("show-info");
  }

  async toggleFullscreen() {
    try {
      const w = getCurrentWindow();
      const fs = await w.isFullscreen();
      await w.setFullscreen(!fs);
      this.wentFullscreen = !fs;
    } catch {
      /* ignore */
    }
  }

  /** 評分等資料變更後更新說明文字 */
  refreshCaption() {
    const id = this.currentId();
    if (id !== null) this.caption.innerHTML = this.host.caption(id);
  }

  // ------------------------------------------------------------ 內部

  private targetVolume() {
    return this.muted ? 0 : this.settings.volume;
  }

  private finish() {
    // 不循環時，停在最後一張後淡出音樂並結束
    this.fadeAudio(0, MUSIC_FADE_MS, () => this.stop());
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.paused || !this.active) return;
    this.timer = window.setTimeout(() => this.next(), this.intervalMs);
  }

  private show(i: number) {
    clearTimeout(this.timer);
    this.index = i;
    const id = this.slides[i];
    const t = ++this.token;
    const back = this.layers[1 - this.front];
    let revealed = false;
    const reveal = () => {
      // 圖片若已在快取中，complete 與 onload 可能都會觸發；只能切換一次，否則兩層都會被隱藏
      if (revealed || t !== this.token || !this.active) return;
      revealed = true;
      back.onload = back.onerror = null;
      const front = this.layers[this.front];
      back.classList.remove("kb");
      if (this.settings.transition === "kenburns") {
        // 每張隨機一個推近的起點，動畫長度 = 停留時間 + 轉場時間
        back.style.setProperty("--kb-x", `${20 + Math.random() * 60}%`);
        back.style.setProperty("--kb-y", `${20 + Math.random() * 60}%`);
        back.style.setProperty("--kb-dur", `${this.intervalMs + FADE_MS}ms`);
        void back.offsetWidth; // 重新觸發動畫
        back.classList.add("kb");
      }
      back.classList.add("on");
      front.classList.remove("on");
      this.front = 1 - this.front;
      this.caption.innerHTML = this.host.caption(id);
      this.countEl.textContent = `${i + 1} / ${this.slides.length}`;
      this.schedule();
      this.prefetch(i);
    };
    back.onload = reveal;
    back.onerror = () => {
      if (t === this.token) this.timer = window.setTimeout(() => this.next(), 500);
    };
    back.src = this.host.previewUrl(id);
    if (back.complete && back.naturalWidth) reveal();
  }

  private prefetch(i: number) {
    this.prefetched = [];
    for (const d of [1, 2]) {
      const n = this.slides[(i + d) % this.slides.length];
      if (n === undefined) continue;
      const im = new Image();
      im.src = this.host.previewUrl(n);
      this.prefetched.push(im);
    }
  }

  private playTrack(n: number, first = false) {
    const list = this.settings.music;
    clearInterval(this.trackTicker);
    if (!this.active || !list.length) {
      this.renderTrack();
      return;
    }
    this.track = n % list.length;
    const t = ++this.trackToken;
    this.renderTrack();
    audioSrc(list[this.track])
      .then((src) => {
        if (t !== this.trackToken || !this.active) return;
        this.audio.src = src;
        this.audio.volume = 0;
        if (this.paused) return;
        return this.audio.play().then(() => this.fadeAudio(this.targetVolume(), first ? MUSIC_FADE_MS : 300));
      })
      .catch(() => {
        this.renderTrack(true);
        if (this.active && list.length > 1) setTimeout(() => this.playTrack(this.track + 1), 300);
      });
    this.trackTicker = window.setInterval(() => this.renderTrack(), 1000);
  }

  private renderTrack(failed = false) {
    const list = this.settings.music;
    if (!list.length) {
      this.trackEl.textContent = "";
      return;
    }
    const name = fileName(list[this.track]);
    this.trackEl.textContent = failed
      ? `♪ 無法播放：${name}`
      : `♪ ${name}  ${fmtTime(this.audio.currentTime)} / ${fmtTime(this.audio.duration)}`;
  }

  private fadeAudio(to: number, ms: number, done?: () => void) {
    clearInterval(this.fadeTimer);
    const from = this.audio.volume;
    const start = performance.now();
    this.fadeTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - start) / ms);
      this.audio.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k >= 1) {
        clearInterval(this.fadeTimer);
        this.fadeTimer = 0;
        done?.();
      }
    }, 40);
  }

  /** 滑鼠移動時顯示控制列，靜止 2.5 秒後自動隱藏（游標也一起隱藏） */
  private wake() {
    this.root.classList.add("awake");
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (!this.paused) this.root.classList.remove("awake");
    }, 2500);
  }
}

function shuffle<T>(a: T[]): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
