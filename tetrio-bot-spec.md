# TETR.IO AI Bot — Chrome Extension 專案規格書

## 1. 專案概述

### 目標
開發一個 Chrome Extension，能在 TETR.IO（tetr.io）的 Zen 模式下自動玩俄羅斯方塊。Bot 透過注入腳本讀取遊戲內部狀態，使用評分函數搜尋演算法決定最佳落點，並模擬鍵盤事件執行操作。

### 定位
- **個人學習 / 技術研究用途**
- 僅在 Zen 模式（單人無限練習）下運行
- 未來可擴展至 Custom Room（私人房間）

### 技術棧
- **語言**：TypeScript
- **平台**：Chrome Extension（Manifest V3）
- **目標網站**：https://tetr.io

---

## 2. 系統架構

### 2.1 Chrome Extension 結構（Manifest V3）

```
tetrio-bot/
├── manifest.json           # Extension 設定（Manifest V3）
├── src/
│   ├── background/
│   │   └── service-worker.ts  # Background service worker
│   ├── content/
│   │   └── content-script.ts  # 注入 tetr.io 頁面的 content script
│   ├── injected/
│   │   └── game-hook.ts       # 注入頁面上下文，攔截遊戲狀態
│   ├── ai/
│   │   ├── engine.ts          # AI 決策引擎主邏輯
│   │   ├── evaluator.ts       # 盤面評分函數
│   │   ├── piece.ts           # 方塊定義與旋轉（SRS）
│   │   └── board.ts           # 盤面模擬（放置、消行、碰撞檢測）
│   ├── controller/
│   │   └── input.ts           # 鍵盤事件模擬器
│   ├── popup/
│   │   ├── popup.html         # Extension 彈出式 UI
│   │   └── popup.ts           # UI 控制邏輯
│   └── types/
│       └── index.ts           # 共用型別定義
├── tsconfig.json
├── package.json
└── webpack.config.js          # 或 vite / esbuild 打包設定
```

### 2.2 元件職責與資料流

```
┌─────────────────────────────────────────────────┐
│  Chrome Extension                               │
│                                                 │
│  ┌──────────┐    訊息     ┌──────────────────┐  │
│  │  Popup   │◄──────────►│  Service Worker   │  │
│  │  (UI)    │            │  (Background)      │  │
│  └──────────┘            └────────┬───────────┘  │
│                                   │ 訊息          │
│  ┌────────────────────────────────▼───────────┐  │
│  │  Content Script                             │  │
│  │  ┌──────────────┐  ┌───────────────────┐   │  │
│  │  │ Game Hook    │  │  AI Engine        │   │  │
│  │  │ (注入頁面    │──►│  (評分+搜尋)      │   │  │
│  │  │  讀取狀態)   │  └────────┬──────────┘   │  │
│  │  └──────────────┘           │               │  │
│  │                    ┌────────▼──────────┐    │  │
│  │                    │  Input Controller │    │  │
│  │                    │  (模擬鍵盤事件)    │    │  │
│  │                    └───────────────────┘    │  │
│  └────────────────────────────────────────────┘  │
│                                                 │
└─────────────────────────────────────────────────┘
```

**資料流：**
1. **Game Hook** 注入 tetr.io 頁面上下文，攔截遊戲 JS 物件，取得盤面狀態
2. 狀態透過 `window.postMessage` 傳給 **Content Script**
3. **Content Script** 將狀態傳入 **AI Engine** 計算最佳落點
4. AI 決策結果傳給 **Input Controller**
5. **Input Controller** 透過 `KeyboardEvent` 模擬按鍵操作遊戲

---

## 3. 核心模組詳細規格

### 3.1 Game Hook（遊戲狀態讀取）

#### 功能
注入一段 script 到 tetr.io 頁面的 main world context，攔截遊戲內部物件。

#### 需要擷取的遊戲狀態

```typescript
interface GameState {
  board: number[][];        // 10x20 盤面矩陣（0=空, 1-7=不同方塊顏色）
  currentPiece: {
    type: PieceType;        // I, O, T, S, Z, J, L
    rotation: number;       // 0-3（SRS 旋轉狀態）
    x: number;              // 目前 x 座標
    y: number;              // 目前 y 座標
  };
  nextQueue: PieceType[];   // 預覽佇列（至少 5 個）
  holdPiece: PieceType | null; // Hold 中的方塊
  canHold: boolean;         // 本回合是否還能 Hold
  isPlaying: boolean;       // 遊戲是否進行中
  linesCleared: number;     // 已消除行數
  level: number;            // 當前等級
}

type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
```

#### 實作策略

TETR.IO 使用 Canvas 渲染遊戲畫面，但遊戲邏輯存在於 JavaScript 物件中。需要：

1. **方法一（優先）：攔截遊戲物件**
   - 透過覆寫 `Object.defineProperty` 或 `Proxy` 來攔截遊戲初始化時建立的關鍵物件
   - 或是在 window 上尋找暴露的遊戲實例（TETR.IO 可能使用 webpack bundle，需要找到正確的 module）
   - 參考現有的 tetrio-minus extension 如何 hook 遊戲

2. **方法二（備選）：Canvas 像素讀取**
   - 如果無法直接取得 JS 物件，使用 `canvas.getContext('2d').getImageData()` 讀取像素
   - 根據顏色對應表判斷每個格子的方塊類型
   - 需要校準盤面位置座標

3. **方法三（備選）：Memory/Network 攔截**
   - 攔截 WebSocket 訊息（TETR.IO 的多人模式使用 WebSocket 通訊）
   - Zen 模式可能是純本地運算，此方法可能不適用

> **建議**：先嘗試方法一，如果因為程式碼混淆無法找到遊戲物件，再退回方法二。

### 3.2 AI Engine（決策引擎）

#### 演算法：評分函數 + 窮舉搜尋

**核心流程：**
```
對於當前方塊（含 Hold 替換選項）：
  1. 列舉所有可能的旋轉狀態（0°, 90°, 180°, 270°）
  2. 對每個旋轉，列舉所有合法的水平位置
  3. 模擬方塊硬降（hard drop）到該位置
  4. 計算放置後的盤面評分
  5. 選擇評分最高的（旋轉, 位置）組合
```

#### 盤面評分函數

評分由多個特徵的加權總和組成：

```typescript
interface EvaluationWeights {
  linesCleared: number;      // 消除的行數（正分，鼓勵消行）
  holes: number;             // 盤面中的洞數（負分，洞越少越好）
  bumpiness: number;         // 相鄰列高度差之和（負分，越平越好）
  aggregateHeight: number;   // 所有列高度之和（負分，越低越好）
  completeLines: number;     // 完成行的額外獎勵
  wellDepth: number;         // 井的深度（適度正分，為 I 型方塊留井）
  rowTransitions: number;    // 行轉換次數（負分）
  columnTransitions: number; // 列轉換次數（負分）
  boardHeight: number;       // 最高列的高度（負分）
}
```

**建議初始權重**（基於 ElTetris 研究，可後續調整）：
```typescript
const DEFAULT_WEIGHTS: EvaluationWeights = {
  linesCleared: 1.0,
  holes: -4.0,
  bumpiness: -0.5,
  aggregateHeight: -0.5,
  completeLines: 3.0,
  wellDepth: 0.2,
  rowTransitions: -0.5,
  columnTransitions: -0.8,
  boardHeight: -0.2,
};
```

#### SRS 旋轉系統（Super Rotation System）

TETR.IO 使用標準 SRS。AI 必須實作完整的 SRS，包含 wall kick 資料表，才能正確模擬所有合法的放置位置。

```typescript
// 7 種方塊在 4 種旋轉狀態下的形狀定義
// Wall kick 偏移表（用於碰撞時的位移測試）
// 參考：https://tetris.wiki/Super_Rotation_System
```

#### 搜尋深度

- **Phase 1（MVP）**：只看當前方塊，深度 1
- **Phase 2（進階）**：考慮當前方塊 + 下一個方塊，深度 2
- **Phase 3（高級）**：考慮 Hold 交換 + 下一個方塊，深度 2 + Hold

### 3.3 Input Controller（鍵盤模擬）

#### 操作映射

```typescript
// TETR.IO 預設按鍵配置
const KEY_MAP = {
  moveLeft: 'ArrowLeft',
  moveRight: 'ArrowRight',
  softDrop: 'ArrowDown',
  hardDrop: 'Space',
  rotateCW: 'ArrowUp',     // 順時針旋轉
  rotateCCW: 'KeyZ',       // 逆時針旋轉
  rotate180: 'KeyA',       // 180° 旋轉
  hold: 'KeyC',            // Hold
};
```

#### 操作序列產生

根據 AI 決策的目標位置，計算需要的按鍵序列：

```
1. 判斷是否需要 Hold → 按 Hold 鍵
2. 計算需要旋轉幾次 → 按旋轉鍵
3. 計算需要左/右移幾格 → 按方向鍵
4. 硬降 → 按 Space
```

#### 按鍵模擬方式

```typescript
function simulateKey(key: string) {
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { 
    code: key, 
    bubbles: true 
  }));
  // 適當延遲後
  target.dispatchEvent(new KeyboardEvent('keyup', { 
    code: key, 
    bubbles: true 
  }));
}
```

#### 操作速度控制

- 每次按鍵之間需有適當間隔（建議 30-80ms），避免操作太快被遊戲忽略
- 可在 Popup UI 中提供速度調節滑桿
- Zen 模式無時間壓力，可設定較保守的間隔以確保穩定性

### 3.4 Popup UI（使用者介面）

#### 功能需求

```
┌─────────────────────────────┐
│  TETR.IO Bot Control Panel  │
│                             │
│  狀態: ● 已連線 / ○ 未連線   │
│                             │
│  [▶ 開始] [⏸ 暫停] [⏹ 停止] │
│                             │
│  操作速度: ━━━━●━━━ 快       │
│            慢              │
│                             │
│  ── 統計 ──                 │
│  已放置方塊: 1,234          │
│  已消除行數: 456            │
│  每秒方塊數: 2.5 pps        │
│                             │
│  ── AI 設定 ──              │
│  搜尋深度: [1] [2]          │
│  顯示決策: ☑                │
│                             │
│  ── 除錯 ──                 │
│  顯示盤面狀態: ☑            │
│  記錄決策日誌: ☐            │
│                             │
└─────────────────────────────┘
```

---

## 4. 開發計畫（分階段）

### Phase 1 — MVP（核心功能）
**目標**：能在 Zen 模式下自動放置方塊並消行

- [ ] 建立 Chrome Extension 骨架（Manifest V3）
- [ ] 實作 Game Hook，成功讀取盤面狀態
- [ ] 實作基本的 7 種方塊定義與 SRS 旋轉
- [ ] 實作盤面模擬（放置、消行、碰撞檢測）
- [ ] 實作深度 1 的評分函數搜尋
- [ ] 實作鍵盤模擬，能自動放置方塊
- [ ] 基本 Popup UI（開始/停止按鈕）

### Phase 2 — 強化 AI
**目標**：提升 AI 策略品質

- [ ] 加入 Hold 功能的決策邏輯
- [ ] 提升搜尋深度至 2（考慮下一個方塊）
- [ ] 調整評分函數權重（可選：粒子群最佳化 / 手動調參）
- [ ] 加入 T-Spin 偵測與獎勵
- [ ] 處理垃圾行（garbage lines）的策略

### Phase 3 — 優化與擴展
**目標**：提升使用體驗與穩定性

- [ ] 完善 Popup UI（統計、速度控制、除錯面板）
- [ ] 加入盤面視覺化 overlay（在遊戲中顯示 AI 決策路徑）
- [ ] 支援自訂按鍵配置
- [ ] 支援 Custom Room 模式
- [ ] 效能優化（Web Worker 執行 AI 運算避免阻塞）

---

## 5. 技術細節與注意事項

### 5.1 Manifest V3 設定

```json
{
  "manifest_version": 3,
  "name": "TETR.IO AI Bot",
  "version": "0.1.0",
  "description": "AI bot for TETR.IO Zen mode (研究/學習用途)",
  "permissions": ["activeTab", "scripting"],
  "host_permissions": ["https://tetr.io/*"],
  "background": {
    "service_worker": "dist/background.js"
  },
  "content_scripts": [{
    "matches": ["https://tetr.io/*"],
    "js": ["dist/content-script.js"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "popup.html"
  }
}
```

### 5.2 Content Script 與頁面上下文的溝通

由於 content script 與頁面的 JS 上下文是隔離的，Game Hook 需要透過注入 `<script>` 標籤的方式進入頁面的 main world：

```typescript
// content-script.ts
const script = document.createElement('script');
script.src = chrome.runtime.getURL('dist/game-hook.js');
document.head.appendChild(script);

// 透過 window.postMessage 接收遊戲狀態
window.addEventListener('message', (event) => {
  if (event.data.type === 'TETRIO_GAME_STATE') {
    handleGameState(event.data.state);
  }
});
```

### 5.3 打包工具建議

使用 **Webpack 5** 或 **Vite** 搭配 TypeScript：
- 多入口點打包（background, content-script, game-hook, popup）
- 支援 source map 方便除錯
- 建議使用 `webpack` 因為 Chrome Extension 生態支援較成熟

### 5.4 重要限制與風險

1. **遊戲更新風險**：TETR.IO 經常更新，可能改變內部物件結構。Game Hook 的實作需要有良好的錯誤處理，並且盡量用通用的方式找到遊戲物件。

2. **反作弊機制**：TETR.IO 有反作弊系統。Zen 模式風險最低，但仍應注意：
   - 不要操作過快（保持合理的 PPS，建議 < 5 pps）
   - 不要在排名模式下使用
   - 不要提交被 bot 操作的成績到排行榜

3. **Canvas 渲染**：TETR.IO 使用 WebGL/Canvas 渲染，DOM 中不包含遊戲邏輯資訊。必須透過 JS 物件攔截或像素分析取得狀態。

---

## 6. 參考資源

### 演算法參考
- **ElTetris 演算法**：評分函數式 Tetris AI 的經典實作
  - 核心概念：窮舉所有落點，用加權評分函數選最佳位置
- **SRS 旋轉系統**：https://tetris.wiki/Super_Rotation_System
- **Tetris Bot Protocol (TBP)**：標準化的 Tetris bot 通訊協議

### 現有專案參考
- `misterhat/tetrio-bot`：使用 ElTetris + RobotJS，螢幕擷取方式
- `ahmedrangel/tetrio-bot`：使用 `@haelp/teto` 函式庫 + ElTetris，API 方式
- `xie-daniel/tetrabot`：Python 實作，有清楚的模組拆分（tryPlacement, evaluateBoard）
- `AlexanderLJX/Tetrio-bot`：顏色比對 + 暴力搜尋

### TETR.IO 遊戲機制
- 10 寬 x 20 高的盤面（內部可能有額外的隱藏行）
- 標準 7-bag 隨機方塊生成
- SRS 旋轉系統（含 wall kick）
- 支援 Hold（每回合限用一次）
- 預覽佇列至少顯示 5 個方塊

---

## 7. 成功標準

### MVP 達標條件
- ✅ Extension 安裝後能在 tetr.io 頁面正確載入
- ✅ 能讀取到當前盤面狀態、當前方塊、預覽佇列
- ✅ 能自動放置方塊到 AI 決定的位置
- ✅ 在 Zen 模式下能持續運行 100+ 行不死
- ✅ 有基本的 UI 可以控制開始/停止

### 進階目標
- 能在 Zen 模式下持續運行 1,000+ 行不死
- 平均 PPS（pieces per second）達到 2-3
- 能執行基本的 T-Spin 操作
- 能適應有垃圾行的情境
