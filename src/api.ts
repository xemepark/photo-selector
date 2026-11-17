import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export type Kind = "raw+jpeg" | "raw" | "jpeg" | "image" | "other";

export interface Item {
  id: number;
  name: string;
  kind: Kind;
  files: string[];
  size: number;
  mtime: number;
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

// Linux / macOS：img://localhost/   Windows：http://img.localhost/
const base = convertFileSrc("", "img");

export const url = {
  thumb: (session: number, id: number, retry = 0) => `${base}t/${session}/${id}${retry ? `?r=${retry}` : ""}`,
  preview: (session: number, id: number) => `${base}p/${session}/${id}`,
  full: (session: number, id: number) => `${base}f/${session}/${id}`,
};

export const api = {
  openFolder: (path: string) => invoke<OpenResult>("open_folder", { path }),
  setViewport: (session: number, ids: number[]) => invoke<void>("set_viewport", { session, ids }),
  setRating: (session: number, ids: number[], rating: number) => invoke<void>("set_rating", { session, ids, rating }),
  setLabel: (session: number, ids: number[], label: string | null) => invoke<void>("set_label", { session, ids, label }),
  transfer: (session: number, ids: number[], dest: string, mode: "copy" | "move") =>
    invoke<TransferResult>("transfer", { session, ids, dest, mode }),
  analyze: (session: number, ids: number[]) => invoke<void>("analyze", { session, ids }),
  cacheInfo: () => invoke<[string, number]>("cache_info"),
  clearCache: () => invoke<void>("clear_cache"),
  defaultFolder: () => invoke<string | null>("default_folder"),
  initialFolder: () => invoke<string | null>("initial_folder"),
  allowAudio: (paths: string[]) =>
    invoke<{ allowed: string[]; rejected: [string, string][] }>("allow_audio", { paths }),
};

/** 色彩標籤：XMP 存的值 ↔ 顯示 */
export const LABELS = [
  { key: "6", value: "Red", name: "紅", color: "var(--red)" },
  { key: "7", value: "Yellow", name: "黃", color: "var(--yellow)" },
  { key: "8", value: "Green", name: "綠", color: "var(--green)" },
  { key: "9", value: "Blue", name: "藍", color: "var(--blue)" },
  { key: "", value: "Purple", name: "紫", color: "var(--purple)" },
] as const;

export function labelColor(label?: string | null): string | null {
  if (!label) return null;
  const l = LABELS.find((x) => x.value.toLowerCase() === label.toLowerCase());
  return l ? l.color : "var(--muted)";
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
