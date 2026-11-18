// 左側常駐的資料夾樹（仿 Adobe Bridge「檔案夾」面板）：
// 常用位置與所有磁碟為最上層，展開時才讀取子資料夾；切換資料夾時樹維持原狀，
// 目前的資料夾會反白，並自動展開到它所在的位置。

import { invoke } from "@tauri-apps/api/core";

interface DirNode {
  name: string;
  path: string;
  has_children: boolean;
}

interface RootNode extends DirNode {
  kind: "home" | "desktop" | "downloads" | "pictures" | "volume";
}

interface Node {
  name: string;
  path: string;
  icon: string;
  hasChildren: boolean;
  children?: Node[];
  open: boolean;
  loading: boolean;
  error?: string;
}

const ICONS: Record<RootNode["kind"], string> = {
  home: "🏠",
  desktop: "🖥",
  downloads: "⬇️",
  pictures: "🖼",
  volume: "💽",
};

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function sepOf(p: string) {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

/** p 是否在 root 底下（或就是 root） */
function under(p: string, root: string) {
  if (p === root) return true;
  const sep = sepOf(root);
  const r = root.endsWith(sep) ? root : root + sep;
  return p.startsWith(r);
}

export class FolderTree {
  private favs: Node[] = [];
  private vols: Node[] = [];
  private current = "";
  private openRoots = new Set<string>();

  constructor(
    private el: HTMLElement,
    private onOpen: (path: string) => void,
  ) {
    el.addEventListener("click", (ev) => this.onClick(ev));
  }

  async init() {
    const roots = await invoke<RootNode[]>("list_roots").catch(() => [] as RootNode[]);
    const mk = (r: RootNode): Node => ({
      name: r.name,
      path: r.path,
      icon: ICONS[r.kind] ?? "📁",
      hasChildren: r.has_children,
      open: false,
      loading: false,
    });
    this.favs = roots.filter((r) => r.kind !== "volume").map(mk);
    this.vols = roots.filter((r) => r.kind === "volume").map(mk);
    this.render();
    if (this.current) await this.reveal(this.current);
  }

  /** 重新讀取（新增 / 改名資料夾、插上外接硬碟之後） */
  async refresh() {
    const keepOpen = new Set<string>();
    const walk = (ns: Node[]) =>
      ns.forEach((n) => {
        if (n.open) keepOpen.add(n.path);
        if (n.children) walk(n.children);
      });
    walk([...this.favs, ...this.vols]);
    await this.init();
    // 重新展開原本開著的資料夾
    const reopen = async (ns: Node[]) => {
      for (const n of ns) {
        if (keepOpen.has(n.path) && n.hasChildren) {
          await this.load(n);
          n.open = true;
          if (n.children) await reopen(n.children);
        }
      }
    };
    await reopen([...this.favs, ...this.vols]);
    this.render();
  }

  private async load(n: Node) {
    if (n.children || n.loading) return;
    n.loading = true;
    this.render();
    try {
      const list = await invoke<DirNode[]>("list_dirs", { path: n.path });
      n.children = list.map((d) => ({ name: d.name, path: d.path, icon: "📁", hasChildren: d.has_children, open: false, loading: false }));
      n.hasChildren = n.children.length > 0;
      n.error = undefined;
    } catch (e) {
      n.children = [];
      n.error = String(e);
    } finally {
      n.loading = false;
    }
  }

  /** 標示目前的資料夾，並展開到它的位置 */
  async reveal(path: string) {
    this.current = path;
    // 找出包含這個路徑、路徑最長（最貼近）的最上層節點
    const roots = [...this.favs, ...this.vols];
    let root: Node | undefined;
    for (const r of roots) if (under(path, r.path) && (!root || r.path.length > root.path.length)) root = r;
    if (root) {
      let node = root;
      while (node.path !== path) {
        await this.load(node);
        node.open = true;
        const next = node.children?.find((c) => under(path, c.path));
        if (!next) break;
        node = next;
      }
    }
    this.render();
    this.el.querySelector<HTMLElement>(".tree-row.current")?.scrollIntoView({ block: "nearest" });
  }

  private find(path: string, ns = [...this.favs, ...this.vols]): Node | undefined {
    for (const n of ns) {
      if (n.path === path) return n;
      if (n.children && under(path, n.path)) {
        const f = this.find(path, n.children);
        if (f) return f;
      }
    }
    return undefined;
  }

  private async onClick(ev: MouseEvent) {
    const t = ev.target as HTMLElement;
    if (t.closest("[data-act=refresh]")) return void this.refresh();
    const sec = t.closest<HTMLElement>("[data-section]");
    if (sec && !t.closest(".tree-row")) {
      const k = sec.dataset.section!;
      this.openRoots.has(k) ? this.openRoots.delete(k) : this.openRoots.add(k);
      return this.render();
    }
    const row = t.closest<HTMLElement>(".tree-row");
    if (!row) return;
    const n = this.find(row.dataset.path!);
    if (!n) return;
    if (t.closest(".twisty")) {
      // 點箭頭：展開 / 收合
      if (!n.open) await this.load(n);
      n.open = !n.open && !!n.hasChildren;
      return this.render();
    }
    // 點名稱：開啟資料夾（樹維持原狀）
    this.onOpen(n.path);
  }

  private nodeHtml(n: Node, depth: number): string {
    const twisty = n.loading ? "…" : n.hasChildren ? (n.open ? "▾" : "▸") : "";
    const cur = n.path === this.current ? " current" : "";
    let html = `<div class="tree-row${cur}" data-path="${esc(n.path)}" style="padding-left:${4 + depth * 14}px" title="${esc(n.path)}">
      <span class="twisty">${twisty}</span><span class="ico">${n.icon}</span><span class="nm">${esc(n.name)}</span></div>`;
    if (n.open && n.children) {
      if (n.error) html += `<div class="tree-note" style="padding-left:${22 + depth * 14}px">${esc(n.error)}</div>`;
      html += n.children.map((c) => this.nodeHtml(c, depth + 1)).join("");
    }
    return html;
  }

  render() {
    const section = (key: string, title: string, nodes: Node[]) => {
      if (!nodes.length) return "";
      const closed = this.openRoots.has(key); // 預設展開；點標題收合
      return `<div class="tree-section" data-section="${key}"><span>${closed ? "▸" : "▾"} ${title}</span></div>
        ${closed ? "" : nodes.map((n) => this.nodeHtml(n, 0)).join("")}`;
    };
    const scroll = this.el.scrollTop;
    this.el.innerHTML = section("fav", "常用", this.favs) + section("vol", "裝置", this.vols);
    this.el.scrollTop = scroll;
  }
}
