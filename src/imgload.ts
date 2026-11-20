// 圖片載入（縮圖 / 預覽 / 原圖）：先用 img:// 自訂協定直接載入；
// 如果 WebView 無法直接顯示，就改用 fetch 讀成 blob: 再顯示（相容模式），並找出失敗原因。
//
// 這是為了應付不同平台 WebView 的差異（例如某些 macOS 版本的 WKWebView），
// 讓縮圖在任何環境都能顯示；真的讀不到時把原因顯示出來，方便排除問題。

type Mode = "direct" | "blob";

let mode: Mode = "direct";
let directOk = false;
let fallbackWins = 0;
const MAX_BLOBS = 400;
const blobs = new Map<string, string>(); // 圖片網址 → blob: 網址（LRU）
const listeners = new Set<(msg: string, isError: boolean) => void>();

/** 訂閱診斷訊息（顯示在狀態列） */
export function onImageDiag(cb: (msg: string, isError: boolean) => void) {
  listeners.add(cb);
}

function report(msg: string, isError = true) {
  console[isError ? "error" : "info"]("[image]", msg);
  listeners.forEach((cb) => cb(msg, isError));
}

export function imageMode(): Mode {
  return mode;
}

function remember(url: string, blobUrl: string) {
  blobs.set(url, blobUrl);
  if (blobs.size > MAX_BLOBS) {
    const [k, v] = blobs.entries().next().value as [string, string];
    blobs.delete(k);
    URL.revokeObjectURL(v); // 已顯示的圖片不受影響
  }
}

type FetchResult = { ok: true; src: string } | { ok: false; status: number; msg: string };

async function fetchBlob(url: string): Promise<FetchResult> {
  const hit = blobs.get(url);
  if (hit) {
    blobs.delete(url);
    blobs.set(url, hit);
    return { ok: true, src: hit };
  }
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, status: r.status, msg: `伺服器回應 HTTP ${r.status}` };
    const b = await r.blob();
    if (!b.size) return { ok: false, status: 204, msg: "收到空的圖片資料" };
    const src = URL.createObjectURL(b);
    remember(url, src);
    return { ok: true, src };
  } catch (e) {
    return { ok: false, status: 0, msg: `無法連線到圖片服務（${(e as Error)?.message ?? e}）` };
  }
}

/**
 * 設定圖片來源，失敗時自動改用相容模式。
 * `onFail(status)`：真的讀不到時呼叫（410 = 已捲出畫面而被取消，呼叫端可稍後重試）。
 */
export function setImg(el: HTMLImageElement, url: string, onFail?: (status: number) => void) {
  el.dataset.want = url;
  const current = () => el.dataset.want === url;

  const useResult = (r: FetchResult) => {
    if (!current()) return;
    if (r.ok) {
      el.src = r.src;
    } else {
      // 410 = 捲出畫面被取消、404 = 換了資料夾（舊的請求作廢），呼叫端會自動重試，不算錯誤
      if (r.status !== 410 && r.status !== 404) report(`圖片載入失敗：${r.msg}`);
      onFail?.(r.status);
    }
  };

  if (mode === "blob") {
    fetchBlob(url).then(useResult);
    return;
  }

  el.addEventListener(
    "load",
    () => {
      if (current() && el.src === url) directOk = true;
    },
    { once: true },
  );
  el.addEventListener(
    "error",
    () => {
      if (!current()) return;
      fetchBlob(url).then((r) => {
        if (r.ok && !directOk && ++fallbackWins >= 3 && mode === "direct") {
          mode = "blob";
          report("此系統無法直接顯示圖片，已自動改用相容模式", false);
        }
        useResult(r);
      });
    },
    { once: true },
  );
  el.src = url;
}

/** 清除圖片（元件回收時） */
export function clearImg(el: HTMLImageElement) {
  delete el.dataset.want;
  el.removeAttribute("src");
}

/** 預先載入（之後切換時幾乎零等待） */
export function prefetchImg(url: string, keep: unknown[]) {
  if (mode === "blob") {
    fetchBlob(url);
  } else {
    const im = new Image();
    im.src = url;
    keep.push(im);
  }
}
