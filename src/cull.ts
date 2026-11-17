// 選片分析：模糊（以主角靠近鏡頭那隻眼睛是否對到焦為準）、閉眼（只抓幾乎完全閉上），
// 以及「拍攝類型」（新生兒模式不檢查閉眼）。

export type Eyes = "open" | "closed" | "unknown";

export interface Face {
  /** 人臉框（相對整張照片的比例 x, y, w, h） */
  b: [number, number, number, number];
  blink: [number, number];
  eyes: Eyes;
  sharp: number;
  ear?: [number, number];
  /** 靠近鏡頭那隻眼睛的清晰度；-1 = 無法判斷 */
  eye_sharp?: number;
  /** 靠近鏡頭那隻眼睛的範圍 */
  eye?: [number, number, number, number] | null;
}

export interface Analysis {
  sharp: number;
  faces: Face[];
}

export type ShootMode = "general" | "newborn";

export interface Issues {
  blurry: boolean;
  /** 模糊的判斷依據：主角眼睛 / 整張照片 */
  blurBy: "eye" | "photo" | null;
  closed: number;
  faces: number;
  /** 建議淘汰 */
  cull: boolean;
}

/**
 * 低於「這一批照片中位數 × 比例」才算有問題：不同相機、鏡頭、場景的絕對數值差很多，
 * 用同一批照片互相比較最可靠。
 */
const EYE_RELATIVE = 0.45;
const PHOTO_RELATIVE = 0.35;

function mainEye(a: Analysis): number | null {
  const f = a.faces[0];
  return f && typeof f.eye_sharp === "number" && f.eye_sharp >= 0 ? f.eye_sharp : null;
}

export class Cull {
  analysis = new Map<number, Analysis>();
  mode: ShootMode = "general";
  running = false;
  private photoT = 0;
  private eyeT = 0;

  clear() {
    this.analysis.clear();
    this.running = false;
    this.photoT = this.eyeT = 0;
  }

  add(id: number, a: Analysis) {
    this.analysis.set(id, a);
  }

  recompute() {
    const median = (v: number[]) => {
      if (v.length < 3) return 0;
      v.sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    };
    const all = [...this.analysis.values()];
    this.photoT = median(all.map((a) => a.sharp)) * PHOTO_RELATIVE;
    this.eyeT = median(all.map(mainEye).filter((v): v is number => v !== null)) * EYE_RELATIVE;
  }

  get checksEyes() {
    return this.mode !== "newborn";
  }

  issues(id: number): Issues | null {
    const a = this.analysis.get(id);
    if (!a) return null;
    // 有主角而且看得到眼睛 → 以靠近鏡頭那隻眼睛判斷；沒有人臉才看整張照片
    const eye = mainEye(a);
    let blurry = false;
    let blurBy: Issues["blurBy"] = null;
    if (eye !== null) {
      blurry = this.eyeT > 0 && eye < this.eyeT;
      if (blurry) blurBy = "eye";
    } else {
      blurry = this.photoT > 0 && a.sharp < this.photoT;
      if (blurry) blurBy = "photo";
    }
    const closed = this.checksEyes ? a.faces.filter((f) => f.eyes === "closed").length : 0;
    return { blurry, blurBy, closed, faces: a.faces.length, cull: blurry || closed > 0 };
  }

  /** 篩選用的分類值 */
  facet(key: "suggest" | "eyes" | "sharp", id: number): string {
    const i = this.issues(id);
    if (!i) return "na";
    switch (key) {
      case "suggest":
        return i.cull ? "cull" : "keep";
      case "eyes":
        if (!i.faces) return "noface";
        return i.closed ? "closed" : "open";
      case "sharp":
        return i.blurry ? "blur" : "ok";
    }
  }

  badges(id: number): string {
    const i = this.issues(id);
    if (!i) return "";
    let s = "";
    if (i.closed) s += `<span class="badge warn">閉眼${i.faces > 1 ? ` ${i.closed}/${i.faces}` : ""}</span>`;
    if (i.blurry) s += `<span class="badge warn">${i.blurBy === "eye" ? "眼睛失焦" : "模糊"}</span>`;
    return s;
  }
}

/** 以 object-fit: contain 顯示時，圖片實際內容在畫面上的位置 */
export function contentRect(img: HTMLImageElement) {
  const r = img.getBoundingClientRect();
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  const s = Math.min(r.width / iw, r.height / ih);
  const w = iw * s;
  const h = ih * s;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}

/** 在全螢幕預覽的照片上畫出人臉框與「判斷對焦用的那隻眼睛」 */
export function drawFaces(layer: HTMLElement, img: HTMLImageElement, a: Analysis | undefined, cull: Cull, id: number) {
  layer.innerHTML = "";
  if (!a || !img.complete || !img.naturalWidth) return;
  const r = contentRect(img);
  const issues = cull.issues(id);
  const box = (b: [number, number, number, number], cls: string, label: string) => {
    const el = document.createElement("div");
    el.className = `face-box ${cls}`;
    el.style.left = `${r.left + b[0] * r.width}px`;
    el.style.top = `${r.top + b[1] * r.height}px`;
    el.style.width = `${b[2] * r.width}px`;
    el.style.height = `${b[3] * r.height}px`;
    if (label) el.innerHTML = `<span>${label}</span>`;
    layer.appendChild(el);
  };
  a.faces.forEach((f, k) => {
    let cls = "neutral";
    let label = "";
    if (cull.checksEyes && f.eyes !== "unknown") {
      cls = f.eyes === "closed" ? "bad" : "good";
      label = f.eyes === "closed" ? "閉眼" : "";
    }
    box(f.b, cls, label);
    if (k === 0 && f.eye) {
      const soft = issues?.blurBy === "eye";
      box(f.eye, `eye ${soft ? "bad" : "good"}`, soft ? "眼睛失焦" : "對焦");
    }
  });
}
