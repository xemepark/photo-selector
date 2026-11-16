# Photo Selector

快速的照片瀏覽與選片工具（Rust + Tauri 2）。目標是做到 Adobe Bridge 等級的素材管理功能，
並在「選片」這件事上做得更快、更專注：打開上萬張的資料夾不卡、純鍵盤評分、自動抓出模糊照片。

> 本專案是獨立開發的軟體，與 Adobe 無關，介面與名稱皆為自有設計。

## 開發環境

需求：Rust（stable）、Node.js 18+，以及 Tauri 的系統套件
（Linux 需要 `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`，見 <https://tauri.app/start/prerequisites/>）。

```bash
npm install
npm run tauri dev                       # 開發模式
npm run tauri dev -- -- /path/to/photos # 啟動時直接開某個資料夾
npm run tauri build                     # 打包安裝檔
cargo test --manifest-path src-tauri/Cargo.toml   # 後端單元測試
```

## 目前功能（MVP v0.1）

| 類別 | 功能 |
|---|---|
| 瀏覽 | 虛擬化縮圖格（上萬張照片也只建立畫面上的格子）、縮圖大小調整、資料夾導覽、最近開啟、命令列指定資料夾 |
| 格式 | JPEG、PNG、TIFF、WebP、GIF、BMP；RAW（CR2、CR3、NEF、ARW、DNG、RAF、ORF、RW2、PEF、SRW…）透過內嵌預覽顯示；PSD / HEIC 若有內嵌 JPEG 也能顯示 |
| RAW+JPEG | 同名的 RAW 與 JPEG 自動合併成一個項目，評分、複製、移動會一起處理 |
| 檢視 | 全螢幕預覽（Space）、100% 放大（Z 或點擊，以點擊位置為中心）、2–4 張並排比較（C）、前後張預先載入 |
| 評分 | 0–5 星、拒絕（X）、色彩標籤（6 紅 / 7 黃 / 8 綠 / 9 藍）、評分後自動跳下一張、多選批次評分 |
| 後設資料 | EXIF（拍攝時間、相機、鏡頭、快門、光圈、ISO、焦距、尺寸），評等與標籤寫入 XMP 附屬檔（與 Bridge / Lightroom 相容） |
| 篩選與排序 | 依評等、標籤、檔案類型、清晰度、相機、鏡頭篩選（含數量統計）；依檔名、拍攝時間、評等、大小、清晰度排序 |
| 模糊偵測 | 一鍵分析整個資料夾的清晰度，自動標出「可能模糊」的照片，可篩選 |
| 檔案操作 | 選取項目複製 / 移動到其他資料夾（連同配對檔與 .xmp，不覆蓋同名檔），跨磁碟移動、保留修改時間 |
| 快取 | SQLite 縮圖 / 清晰度快取，可查看大小與清除 |

### 快捷鍵

| 按鍵 | 動作 |
|---|---|
| ← → ↑ ↓ / Home / End / PgUp / PgDn | 移動焦點（加 Shift 延伸選取） |
| 點擊 / Ctrl+點擊 / Shift+點擊 | 單選 / 加選 / 範圍選取 |
| Ctrl+A、Esc | 全選、取消多選 |
| 0–5、X | 評等、拒絕（再按一次取消） |
| 6 / 7 / 8 / 9 | 紅 / 黃 / 綠 / 藍標籤（再按一次取消） |
| Space / Enter / 雙擊 | 全螢幕預覽 |
| Z / 點擊圖片 | 100% 放大 |
| C | 比較選取的 2–4 張 |
| + / − | 縮圖大小 |
| Ctrl+O、Backspace / Ctrl+↑ | 開啟資料夾、上一層 |

## 為什麼快：架構說明

```
前端 (TypeScript, 虛擬化格子)                 後端 (Rust)
<img src="img://localhost/t/<session>/<id>">  ──►  自訂協定 img://
                                                    │ 1. 記憶體 LRU 命中 → 立即回應
set_viewport(可見的 id)  ──────────────────►        │ 2. 進入工作佇列（預覽高優先、縮圖低優先，LIFO）
                                                    │ 3. 工作者取出時若已捲出畫面 → 410 取消
                                                    │ 4. SQLite 磁碟快取命中 → 回應
                                                    │ 5. 產生縮圖：
                                                    │    RAW → 走 TIFF IFD 找內嵌 JPEG（mmap，只讀需要的頁）
                                                    │    JPEG → DCT 縮放解碼（直接解成 1/2、1/4、1/8）
                                                    │    套用 EXIF 方向 → 編碼 → 寫入快取
```

1. **內嵌預覽優先**：RAW 幾乎都內嵌了相機算好的 JPEG。挑「長邊 ≥ 需求中最小的一張」來解碼，完全不做解馬賽克
   （`src-tauri/src/jpeg.rs`、`tiff.rs`）。
2. **DCT 縮放解碼**：解 400px 縮圖時，JPEG 直接以 1/8 尺寸解碼，省下大量 CPU 與記憶體（`render.rs`）。
3. **可取消的優先佇列**：LIFO 讓最新捲到的畫面先處理，捲出畫面的工作直接丟棄（`core.rs`）。
4. **兩層快取**：記憶體 LRU（3000 張縮圖 + 24 張預覽）＋ SQLite 持久化快取，鍵值為路徑 + 修改時間 + 大小（`cache.rs`）。
5. **中繼資料非同步**：先列出檔案讓畫面立刻出現，EXIF / 評等在背景分批讀取後推送給前端。
6. **虛擬化 + 物件池**：DOM 裡只有畫面上下幾列的格子，捲動時重複使用。
7. **全螢幕預先載入**：前後各兩張的預覽先載好，翻頁幾乎零等待。

### 模糊偵測原理

拉普拉斯變異數（Variance of Laplacian）：把影像切成 4×4 區塊，各自計算後取最高的兩塊平均，
所以「主體清楚、背景散景」的照片不會被誤判。分數是相對的：低於該資料夾中位數 35% 的照片才標為「可能模糊」（`blur.rs`）。

## 專案結構

```
src/                    前端（Vite + TypeScript，無框架）
  main.ts               狀態、篩選排序、全螢幕、比較、快捷鍵
  grid.ts               虛擬化縮圖格
  api.ts                後端指令與型別
src-tauri/src/
  lib.rs                Tauri 指令與 img:// 協定註冊
  core.rs               工作階段、優先佇列、可視範圍取消、記憶體快取
  render.rs             縮圖 / 預覽 / 原圖產生、方向校正
  jpeg.rs               內嵌 JPEG 搜尋與驗證（排除無損 JPEG 的 RAW 資料）
  tiff.rs               TIFF IFD 走訪（RAW 預覽位置、方向、CR3 box）
  meta.rs               EXIF 讀取
  xmp.rs                XMP 評等 / 標籤讀寫（保留其他內容）
  scan.rs               資料夾掃描、RAW+JPEG 配對
  blur.rs               清晰度評分
  cache.rs              SQLite 快取
  ops.rs                複製 / 移動
```

## 已知限制

- JPEG 的評等也寫在 `.xmp` 附屬檔。Lightroom / Bridge 讀 RAW 的附屬檔，但 JPEG 只讀檔案內嵌的 XMP，
  所以在本程式評的 JPEG 星等，Adobe 軟體目前看不到（規劃中：可選擇寫入 JPEG 內嵌 XMP）。
- RAW 只顯示內嵌預覽，沒有自行做 RAW 顯像；沒有內嵌預覽的 RAW 會顯示格式佔位圖。
- HEIC / AVIF 需要 libheif，目前只有在檔案內含 JPEG 縮圖時才能顯示。
- 尚未做色彩管理（ICC），廣色域照片的顏色可能偏淡。

## 路線圖

**v0.2 — 選片強化**
- [ ] 閉眼偵測：ONNX Runtime（`ort` crate）+ 人臉偵測與臉部特徵點模型，計算眼睛開合比例（EAR）
- [ ] 臉部 / 主體區域清晰度（只看主體是否對焦）
- [ ] 相似連拍分組（感知雜湊 dHash + 拍攝時間），每組自動推薦最清晰的一張
- [ ] 縮圖第一階段先顯示 EXIF 內建小縮圖，再換成高品質版本
- [ ] JPEG 內嵌 XMP 寫入（與 Adobe 完全互通）

**v0.3 — Bridge 等級的素材管理**
- [ ] 批次重新命名（範本：日期、序號、原檔名，同步改附屬檔）
- [ ] 關鍵字面板（階層式關鍵字）、IPTC 中繼資料編輯與範本
- [ ] 收藏集、智慧型收藏集（條件式）
- [ ] 堆疊（Stacks）
- [ ] 跨資料夾搜尋、資料夾樹、我的最愛
- [ ] 記憶卡匯入（改名、備份、套用中繼資料）

**v0.4 — 輸出與整合**
- [ ] 匯出 JPEG / PNG（尺寸、品質、浮水印）
- [ ] PDF 聯絡表
- [ ] 以外部編輯器開啟（Photoshop、Lightroom、Capture One…）
- [ ] 色彩管理（ICC）、GPU 繪製
- [ ] RAW 顯像（LibRaw 或 rawler）作為無內嵌預覽時的備援
- [ ] 影片縮圖
