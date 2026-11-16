// 選片分析：模糊、主體失焦、閉眼 / 半閉，以及「拍攝類型」（新生兒模式忽略閉眼）。

export type Eyes = "open" | "half" | "closed" | "unknown";

export interface Face {
  /** 人臉框（相對整張照片的比例 x, y, w, h） */
  b: [number, number, number, number];
  blink: [number, number];
  eyes: Eyes;
  sharp: number;
}

export interface Analysis {
  sharp: number;
  faces: Face[];
}

export type ShootMode = "general" | "newborn";

export const MODE_NAMES: Record<ShootMode, string> = {
  general: "一般（檢查閉眼）",
  newborn: "新生兒（忽略閉眼）",
};

export interface Issues {
  blurry: boolean;
  /** 主角的臉不清楚（整張不模糊，但對焦沒對在臉上） */
  faceSoft: boolean;
  closed: number;
  half: number;
  faces: number;
  /** 建議淘汰 */
  cull: boolean;
}

/** 低於「這一批照片中位數 × 比例」才算有問題：不同相機、不同場景的絕對數值差很多 */
const RELATIVE = 0.35;
/** 主角臉部至少要佔畫面寬度的這個比例，才檢查主體失焦（太小的臉清晰度數值不可靠） */
const MIN_MAIN_FACE = 0.04;

export class Cull {
  analysis = new Map<number, Analysis>();
  mode: ShootMode = "general";
  running = false;
  private blurT = 0;
  private faceT = 0;

  clear() {
    this.analysis.clear();
    this.running = false;
    this.blurT = this.faceT = 0;
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
    this.blurT = median(all.map((a) => a.sharp)) * RELATIVE;
    this.faceT =
      median(all.filter((a) => a.faces[0] && a.faces[0].b[2] >= MIN_MAIN_FACE).map((a) => a.faces[0].sharp)) * RELATIVE;
  }

  get checksEyes() {
    return this.mode !== "newborn";
  }

  issues(id: number): Issues | null {
    const a = this.analysis.get(id);
    if (!a) return null;
    const blurry = this.blurT > 0 && a.sharp < this.blurT;
    const main = a.faces[0];
    const faceSoft =
      !blurry && !!main && main.b[2] >= MIN_MAIN_FACE && this.faceT > 0 && main.sharp < this.faceT;
    const closed = this.checksEyes ? a.faces.filter((f) => f.eyes === "closed").length : 0;
    const half = this.checksEyes ? a.faces.filter((f) => f.eyes === "half").length : 0;
    return { blurry, faceSoft, closed, half, faces: a.faces.length, cull: blurry || faceSoft || closed > 0 };
  }

  /** 篩選用的分類值 */
  facet(key: "suggest" | "eyes" | "sharp", id: number): string {
    const i = this.issues(id);
    if (!i) return "na";
    switch (key) {
      case "suggest":
        return i.cull ? "cull" : i.half ? "check" : "keep";
      case "eyes":
        if (!i.faces) return "noface";
        return i.closed ? "closed" : i.half ? "half" : "open";
      case "sharp":
        return i.blurry ? "blur" : i.faceSoft ? "facesoft" : "ok";
    }
  }

  badges(id: number): string {
    const i = this.issues(id);
    if (!i) return "";
    let s = "";
    if (i.closed) s += `<span class="badge warn">閉眼 ${i.closed}/${i.faces}</span>`;
    else if (i.half) s += `<span class="badge caution">半閉 ${i.half}/${i.faces}</span>`;
    if (i.blurry) s += `<span class="badge warn">模糊</span>`;
    else if (i.faceSoft) s += `<span class="badge caution">主體失焦</span>`;
    return s;
  }

  /** 檢視器資訊欄的文字列 */
  describe(id: number): [string, string][] {
    const a = this.analysis.get(id);
    const i = this.issues(id);
    if (!a || !i) return [];
    const rows: [string, string][] = [];
    rows.push(["清晰度", `${a.sharp.toFixed(0)}${i.blurry ? "（可能模糊）" : ""}`]);
    rows.push(["人臉", a.faces.length ? `${a.faces.length} 位` : "未偵測到"]);
    if (a.faces.length) {
      rows.push(["主體對焦", `${a.faces[0].sharp.toFixed(0)}${i.faceSoft ? "（可能失焦）" : ""}`]);
      if (this.checksEyes) {
        const unknown = a.faces.filter((f) => f.eyes === "unknown").length;
        rows.push([
          "眼睛",
          [
            i.closed ? `${i.closed} 位閉眼` : "",
            i.half ? `${i.half} 位半閉` : "",
            !i.closed && !i.half ? "全部睜眼" : "",
            unknown ? `${unknown} 位太小無法判斷` : "",
          ]
            .filter(Boolean)
            .join("、"),
        ]);
      } else {
        rows.push(["眼睛", "新生兒模式：不檢查"]);
      }
    }
    return rows;
  }
}

/** 在全螢幕預覽的照片上畫出人臉框 */
export function drawFaces(layer: HTMLElement, img: HTMLImageElement, a: Analysis | undefined, cull: Cull, id: number) {
  layer.innerHTML = "";
  if (!a || !img.complete || !img.naturalWidth) return;
  const r = img.getBoundingClientRect();
  const issues = cull.issues(id);
  a.faces.forEach((f, k) => {
    const el = document.createElement("div");
    let cls = "neutral";
    let label = "";
    if (cull.checksEyes) {
      const avg = (f.blink[0] + f.blink[1]) / 2;
      if (f.eyes === "closed") (cls = "bad"), (label = `閉眼 ${avg.toFixed(2)}`);
      else if (f.eyes === "half") (cls = "warn"), (label = `半閉 ${avg.toFixed(2)}`);
      else if (f.eyes === "open") (cls = "good"), (label = `睜眼 ${avg.toFixed(2)}`);
      else label = "太小";
    }
    if (k === 0 && issues?.faceSoft) {
      cls = cls === "bad" ? "bad" : "warn";
      label = `${label ? label + " · " : ""}失焦`;
    }
    el.className = `face-box ${cls}`;
    el.style.left = `${r.left + f.b[0] * r.width}px`;
    el.style.top = `${r.top + f.b[1] * r.height}px`;
    el.style.width = `${f.b[2] * r.width}px`;
    el.style.height = `${f.b[3] * r.height}px`;
    if (label) el.innerHTML = `<span>${label}</span>`;
    layer.appendChild(el);
  });
}
