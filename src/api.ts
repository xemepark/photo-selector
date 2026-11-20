import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export type Kind = "raw+jpeg" | "raw" | "jpeg" | "image" | "other" | "text";

export interface Item {
  id: number;
  name: string;
  kind: Kind;
  files: string[];
  size: number;
  mtime: number;
  /** 加入時間（毫秒） */
  added?: number;
}

export interface Meta {
  capture?: string | null;
  camera?: string | null;
  lens?: string | null;
  iso?: number | null;
  aperture?: number | null;
  shutter?: string | null;
  focal?: number | null;
  width?: number | null;
  height?: number | null;
  rating: number;
  label?: string | null;
  /** 有用「調整」改過 */
  edited?: boolean;
}

export interface EditParams {
  temp: number;
  tint: number;
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  saturation: number;
  /** 點曲線（RGB）：0–255 的 [輸入, 輸出]，空陣列 = 不套用 */
  curve: [number, number][];
  /** HSL：色相 8 格、飽和度 8 格、明亮度 8 格（紅、橙、黃、綠、水綠、藍、紫、洋紅），各 −100…100 */
  hsl: number[];
  /** 裁切：[中心 x, 中心 y, 寬, 高, 角度]（相對原圖寬高的比例；角度 −45…45）。空陣列 = 不裁切 */
  crop: number[];
  /** 局部修補（移除 / 修復 / 仿製） */
  spots: import("./heal").Spot[];
}

export interface DirInfo {
  name: string;
  path: string;
}

export interface OpenResult {
  session: number;
  dir: string;
  parent: string | null;
  subdirs: DirInfo[];
  items: Item[];
}

export interface TransferResult {
  done: number;
  failed: string[];
}

export interface FileInfo {
  parts: { ext: string; size: number }[];
  created: number | null;
  modified: number | null;
  color_space: string | null;
  width: number | null;
  height: number | null;
}

export type ExportFormat = "jpeg" | "tiff" | "png";

export interface ExportOptions {
  /** null = 儲存至相同位置 */
  dest: string | null;
  formats: { format: ExportFormat; fit: [number, number] | null; quality: number; lzw: boolean }[];
  to_srgb: boolean;
  embed_icc: boolean;
  copyright: string;
}

export interface ExportResult {
  done: number;
  failed: string[];
  dirs: string[];
}

// Linux / macOS：img://localhost/   Windows：http://img.localhost/
const base = convertFileSrc("", "img");

// 每次載入都用不同的網址（?n=序號）。
// WebKit 會把「相同網址」的圖片共用同一個載入；若先前的載入因為捲出畫面而被取消，
// 之後同網址的 <img> 會一直卡住，既不顯示也不報錯（大檔案、快速捲動時特別容易發生）。
// 後端有記憶體快取，同一張圖重複要求仍然很快。
let seq = 0;
const n = () => `?n=${++seq}`;

export const url = {
  thumb: (session: number, id: number) => `${base}t/${session}/${id}${n()}`,
  /** 快速小縮圖（檔案內嵌的小圖，正式縮圖好之前先顯示） */
  quick: (session: number, id: number) => `${base}q/${session}/${id}${n()}`,
  medium: (session: number, id: number) => `${base}m/${session}/${id}${n()}`,
  preview: (session: number, id: number) => `${base}p/${session}/${id}${n()}`,
  full: (session: number, id: number) => `${base}f/${session}/${id}${n()}`,
  /** 調整視窗用：未套用調整的預覽 */
  base: (session: number, id: number) => `${base}o/${session}/${id}${n()}`,
};

export const api = {
  openFolder: (path: string) => invoke<OpenResult>("open_folder", { path }),
  setViewport: (session: number, ids: number[]) => invoke<void>("set_viewport", { session, ids }),
  setOrder: (session: number, ids: number[]) => invoke<void>("set_order", { session, ids }),
  readText: (session: number, id: number) => invoke<{ text: string; rtf: boolean; name: string }>("read_text", { session, id }),
  writeText: (session: number, id: number, text: string) => invoke<void>("write_text", { session, id, text }),
  createText: (dir: string, name: string, text: string) => invoke<string>("create_text", { dir, name, text }),
  /** 旋轉 90°，存回原檔；回傳 [id, 新方向] */
  rotate: (session: number, ids: number[], clockwise: boolean) =>
    invoke<{ done: [number, number][]; failed: string[] }>("rotate", { session, ids, clockwise }),
  setRating: (session: number, ids: number[], rating: number) => invoke<void>("set_rating", { session, ids, rating }),
  setLabel: (session: number, ids: number[], label: string | null) => invoke<void>("set_label", { session, ids, label }),
  /** applyEdits：有調整的照片輸出「已套用調整」的檔案（移動時原檔移到垃圾桶） */
  transfer: (session: number, ids: number[], dest: string, mode: "copy" | "move", applyEdits = true) =>
    invoke<TransferResult>("transfer", { session, ids, dest, mode, applyEdits }),
  deleteItems: (session: number, ids: number[]) => invoke<TransferResult>("delete_items", { session, ids }),
  batchRename: (
    session: number,
    entries: { id: number; stem: string }[],
    mode: "rename" | "move" | "copy",
    dest: string | null,
    preserve: boolean,
    applyEdits = true,
  ) => invoke<TransferResult>("batch_rename", { session, entries, mode, dest, preserve, applyEdits }),
  /** 拖曳到其他程式前：取得要拖的檔案路徑與拖曳圖示 */
  dragPrepare: (session: number, ids: number[], includeRaw: boolean, applyEdits = true) =>
    invoke<{ files: string[]; icon: string }>("drag_prepare", { session, ids, includeRaw, applyEdits }),
  /** 壓縮打包成 ZIP（進度：zip-progress 事件） */
  makeZip: (session: number, ids: number[], dest: string, includeRaw: boolean, applyEdits: boolean) =>
    invoke<TransferResult>("make_zip", { session, ids, dest, includeRaw, applyEdits }),
  /** 背景先準備好有調整照片的拖曳用檔案 */
  prepareDrag: (session: number, ids: number[]) => invoke<void>("prepare_drag", { session, ids }),
  forgetThumbs: (session: number, ids: number[]) => invoke<void>("forget_thumbs", { session, ids }),
  getEdit: (session: number, id: number) => invoke<EditParams>("get_edit", { session, id }),
  /** fields 有值時只覆寫這些項目（同步部分設定），其他保留各自的值 */
  saveEdit: (session: number, ids: number[], params: EditParams, fields: string[] | null = null) =>
    invoke<{ done: number; failed: string[]; edited: [number, boolean][] }>("save_edit", { session, ids, params, fields }),
  fileInfo: (session: number, id: number) => invoke<FileInfo>("file_info", { session, id }),
  exportImages: (session: number, ids: number[], options: ExportOptions) =>
    invoke<ExportResult>("export_images", { session, ids, options }),
  exportCancel: () => invoke<void>("export_cancel"),
  revealItem: (session: number, id: number) => invoke<void>("reveal_item", { session, id }),
  openDir: (path: string) => invoke<void>("open_dir", { path }),
  openWebsite: () => invoke<void>("open_website"),
  /** 開啟內建連結：website = smallday.tw、crop = 照片裁切輸出 */
  openLink: (name: "website" | "crop") => invoke<void>("open_link", { name }),
  resolvePath: (input: string) => invoke<{ dir: string; file: string | null }>("resolve_path", { input }),
  analyze: (session: number, ids: number[]) => invoke<void>("analyze", { session, ids }),
  cacheInfo: () => invoke<[string, number]>("cache_info"),
  clearCache: () => invoke<void>("clear_cache"),
  defaultFolder: () => invoke<string | null>("default_folder"),
  initialFolder: () => invoke<string | null>("initial_folder"),
  appVersion: () => invoke<string>("app_version"),
  allowAudio: (paths: string[]) =>
    invoke<{ allowed: string[]; rejected: [string, string][] }>("allow_audio", { paths }),
};

// ---------------------------------------------------------------- 色彩標籤
//
// Bridge / Lightroom 都是把「標籤名稱文字」寫進 XMP（xmp:Label），靠名稱對應顏色。
// Bridge 預設名稱是 Select / Second / Approved / Review / To Do（可在 Bridge 偏好設定 → 標籤 修改），
// Lightroom 則是 Red / Yellow / Green / Blue / Purple。名稱不同時 Bridge 只會顯示成白色標籤，
// 所以寫入時使用使用者設定的名稱（預設與 Bridge 相同），讀取時則認得各種常見名稱。

export type LabelKey = "red" | "yellow" | "green" | "blue" | "purple";

export const LABELS: { key: LabelKey; hotkey: string; zh: string; color: string }[] = [
  { key: "red", hotkey: "6", zh: "紅", color: "var(--red)" },
  { key: "yellow", hotkey: "7", zh: "黃", color: "var(--yellow)" },
  { key: "green", hotkey: "8", zh: "綠", color: "var(--green)" },
  { key: "blue", hotkey: "9", zh: "藍", color: "var(--blue)" },
  { key: "purple", hotkey: "", zh: "紫", color: "var(--purple)" },
];

export type LabelNames = Record<LabelKey, string>;

export const LABEL_PRESETS: { id: string; name: string; names: LabelNames }[] = [
  {
    id: "bridge",
    name: "Adobe Bridge 預設",
    names: { red: "Select", yellow: "Second", green: "Approved", blue: "Review", purple: "To Do" },
  },
  {
    id: "lightroom",
    name: "Lightroom",
    names: { red: "Red", yellow: "Yellow", green: "Green", blue: "Blue", purple: "Purple" },
  },
];

const ZH_ALIASES: Record<LabelKey, string[]> = {
  red: ["紅", "紅色", "红", "红色"],
  yellow: ["黃", "黃色", "黄", "黄色"],
  green: ["綠", "綠色", "绿", "绿色"],
  blue: ["藍", "藍色", "蓝", "蓝色"],
  purple: ["紫", "紫色"],
};

function loadNames(): LabelNames {
  try {
    const v = JSON.parse(localStorage.getItem("labelNames") ?? "null");
    if (v && typeof v === "object") return { ...LABEL_PRESETS[0].names, ...v };
  } catch {
    /* ignore */
  }
  return { ...LABEL_PRESETS[0].names };
}

let labelNames: LabelNames = loadNames();

export function getLabelNames(): LabelNames {
  return { ...labelNames };
}

export function setLabelNames(n: LabelNames) {
  labelNames = { ...n };
  try {
    localStorage.setItem("labelNames", JSON.stringify(labelNames));
  } catch {
    /* ignore */
  }
}

/** 寫入檔案時使用的標籤文字 */
export function labelName(key: LabelKey): string {
  return labelNames[key];
}

/** 檔案中的標籤文字 → 顏色（認得目前設定、Bridge、Lightroom 與中文顏色名稱）；認不得回傳 null */
export function labelKey(text?: string | null): LabelKey | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  const keys = LABELS.map((l) => l.key);
  for (const k of keys) if (labelNames[k].trim().toLowerCase() === t) return k;
  for (const p of LABEL_PRESETS) for (const k of keys) if (p.names[k].toLowerCase() === t) return k;
  for (const k of keys) if (ZH_ALIASES[k].includes(text.trim())) return k;
  return null;
}

export function labelColor(label?: string | null): string | null {
  if (!label) return null;
  const k = labelKey(label);
  return k ? LABELS.find((l) => l.key === k)!.color : "var(--muted)";
}

/** 顯示用名稱：「紅 · Select」；認不得的名稱原樣顯示 */
export function labelDisplay(label?: string | null): string {
  if (!label) return "";
  const k = labelKey(label);
  return k ? `${LABELS.find((l) => l.key === k)!.zh} · ${label}` : label;
}

export function stars(rating: number): string {
  if (rating < 0) return "✕ 拒絕";
  return "★".repeat(Math.min(rating, 5));
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
