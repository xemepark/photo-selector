// 內建的簡易文字編輯器：新增 / 編輯資料夾裡的文字檔（.txt / .md / .rtf）。
// ⌘S（Ctrl+S）儲存、Esc 關閉；有未儲存的修改時先詢問。

import { api } from "./api";

export interface TextEditorHost {
  /** 存檔完成。新檔案回傳實際檔名 */
  saved(r: { kind: "new"; name: string } | { kind: "edit"; id: number }): void;
  closed(): void;
  toast(msg: string): void;
}

type Target = { kind: "new"; dir: string } | { kind: "edit"; session: number; id: number };

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export class TextEditor {
  private root: HTMLDivElement;
  private ta!: HTMLTextAreaElement;
  private target: Target | null = null;
  private original = "";
  private busy = false;
  isOpen = false;

  constructor(private host: TextEditorHost) {
    this.root = document.createElement("div");
    this.root.id = "text-editor";
    this.root.className = "modal hidden";
    document.body.appendChild(this.root);
    this.root.addEventListener("keydown", (ev) => this.onKey(ev));
    this.root.addEventListener("mousedown", (ev) => {
      // 點旁邊的暗處不關閉（避免誤觸丟掉內容）
      if (ev.target === this.root) ev.preventDefault();
    });
  }

  private get dirty() {
    return this.isOpen && this.ta.value !== this.original;
  }

  /** 在資料夾裡新增文字檔 */
  openNew(dir: string) {
    if (!dir) return this.host.toast("請先開啟一個資料夾");
    this.target = { kind: "new", dir };
    this.original = "";
    this.render("新增文字檔", null, "");
    const name = this.q<HTMLInputElement>("[data-f=name]");
    name.focus();
    name.select();
  }

  /** 編輯資料夾裡既有的文字檔 */
  async openEdit(session: number, id: number) {
    try {
      const r = await api.readText(session, id);
      this.target = { kind: "edit", session, id };
      this.original = r.text;
      this.render("編輯文字檔", r, r.text);
      this.ta.focus();
      this.ta.setSelectionRange(0, 0);
      this.ta.scrollTop = 0;
    } catch (e) {
      this.host.toast(`無法開啟：${e}`);
    }
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T;
  }

  private render(title: string, file: { name: string; rtf: boolean } | null, text: string) {
    const nameRow = file
      ? `<div class="te-file">${esc(file.name)}</div>`
      : `<label class="te-name">檔名 <input data-f="name" type="text" value="未命名" spellcheck="false" autocomplete="off" />
           <select data-f="ext"><option value=".txt">.txt</option><option value=".md">.md</option><option value=".rtf">.rtf</option></select></label>`;
    const rtfNote = file?.rtf
      ? `<div class="te-note">這是 RTF 格式的檔案（例如用「文字編輯」存的）。在這裡存檔後，粗體、顏色、字型等格式會移除，只保留文字。</div>`
      : "";
    this.root.innerHTML = `
      <div class="modal-box te-box">
        <div class="te-head"><h2>${title}</h2>${nameRow}</div>
        ${rtfNote}
        <textarea data-f="text" spellcheck="false"></textarea>
        <div class="te-confirm hidden">
          <span>有尚未儲存的修改，要怎麼處理？</span>
          <button data-a="save-close" class="primary">儲存</button>
          <button data-a="discard">不儲存</button>
          <button data-a="keep">繼續編輯</button>
        </div>
        <div class="modal-actions">
          <span class="te-count"></span>
          <button data-a="cancel">取消</button>
          <button data-a="save" class="primary" title="儲存（⌘S）">儲存</button>
        </div>
      </div>`;
    this.ta = this.q<HTMLTextAreaElement>("[data-f=text]");
    this.ta.value = text;
    this.ta.addEventListener("input", () => this.updateCount());
    this.root.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) =>
      b.addEventListener("click", () => {
        const a = b.dataset.a;
        if (a === "save") void this.save(false);
        else if (a === "cancel") this.requestClose();
        else if (a === "save-close") void this.save(true);
        else if (a === "discard") this.close();
        else if (a === "keep") this.hideConfirm();
      }),
    );
    this.updateCount();
    this.root.classList.remove("hidden");
    this.isOpen = true;
  }

  private updateCount() {
    const t = this.ta.value;
    const chars = [...t.replace(/\s/g, "")].length;
    const lines = t ? t.split("\n").length : 0;
    this.q(".te-count").textContent = `${chars} 字 · ${lines} 行${this.dirty ? " · 尚未儲存" : ""}`;
  }

  private onKey(ev: KeyboardEvent) {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      void this.save(false);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      if (!this.q(".te-confirm").classList.contains("hidden")) this.hideConfirm();
      else this.requestClose();
    } else if (ev.key === "Enter" && (ev.target as HTMLElement).dataset.f === "name") {
      ev.preventDefault();
      this.ta.focus();
    } else if (ev.key === "Tab" && ev.target === this.ta && !mod && !ev.shiftKey) {
      // Tab 輸入定位字元，不要跳到別的欄位
      ev.preventDefault();
      const { selectionStart: s, selectionEnd: e } = this.ta;
      this.ta.setRangeText("\t", s, e, "end");
      this.updateCount();
    }
    // 不要讓按鍵傳到背景（評分、切換照片等快捷鍵）
    ev.stopPropagation();
  }

  private requestClose() {
    if (this.dirty) {
      this.q(".te-confirm").classList.remove("hidden");
      this.q<HTMLButtonElement>("[data-a=save-close]").focus();
    } else {
      this.close();
    }
  }

  private hideConfirm() {
    this.q(".te-confirm").classList.add("hidden");
    this.ta.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.target = null;
    this.root.classList.add("hidden");
    this.root.innerHTML = "";
    this.host.closed();
  }

  private async save(closeAfter: boolean) {
    const t = this.target;
    if (!t || this.busy) return;
    const text = this.ta.value;
    this.busy = true;
    try {
      if (t.kind === "new") {
        const base = this.q<HTMLInputElement>("[data-f=name]").value.trim() || "未命名";
        const ext = this.q<HTMLSelectElement>("[data-f=ext]").value;
        const hasExt = /\.(txt|md|markdown|rtf)$/i.test(base);
        const name = await api.createText(t.dir, hasExt ? base : base + ext, text);
        this.original = text;
        this.host.toast(`已新增「${name}」`);
        // 新檔案存好後就變成「編輯」：之後再存是覆寫同一個檔案
        this.close();
        this.host.saved({ kind: "new", name });
        return;
      }
      await api.writeText(t.session, t.id, text);
      this.original = text;
      this.updateCount();
      this.host.toast("已儲存");
      this.host.saved({ kind: "edit", id: t.id });
      if (closeAfter) this.close();
    } catch (e) {
      this.host.toast(`${e}`);
      this.hideConfirm();
    } finally {
      this.busy = false;
    }
  }
}
