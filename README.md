# TETR.IO Bot

一個實驗性的 Chrome 擴充功能：從 TETR.IO 畫面辨識棋盤狀態，使用啟發式搜尋決定落點，再模擬鍵盤完成操作。

## 為什麼做這個專案

這個專案純粹是為了好玩。我手動玩得不算強，便想做一個能在私人對局裡和同學同樂的外掛，也藉此練習畫面辨識、搜尋演算法與瀏覽器擴充功能開發。

> 請只在 Zen／單人練習或所有參與者都知情同意的私人對局使用。不要用於排名、競技或破壞其他玩家體驗，並請遵守 TETR.IO 的現行規則與服務條款。

## 功能

- 以 Canvas 像素讀取棋盤、預覽佇列與 Hold
- 辨識目前方塊並追蹤落子狀態
- Beam search 搭配多組啟發式評分權重
- Safe／Fast 操作速度與三種 AI 強度
- 透過一般鍵盤事件執行移動、旋轉、Hold 與 Hard Drop
- 未驗證落子連續發生時自動暫停，避免失控輸入

## 建置

需要 Node.js 18 以上版本。

```bash
npm ci
npm run build
```

完成後，`dist/` 會包含可載入 Chrome 的擴充功能。

## 安裝

1. 在 Chrome 開啟 `chrome://extensions`。
2. 開啟「開發人員模式」。
3. 選擇「載入未封裝項目」。
4. 選取建置產生的 `dist` 資料夾。

進入 TETR.IO 的 Zen 模式後，從擴充功能彈出視窗開始或停止 Bot。

## 已知限制

- 專案依賴畫面像素與版面位置；網站 UI、主題、縮放或渲染方式改變都可能造成辨識失敗。
- 目前仍屬實驗版本，無法保證每次落子或每種顯示環境都正確。
- 本專案與 TETR.IO 或其開發者無關，也未獲官方背書。

## 技術

TypeScript、Chrome Extension Manifest V3、Canvas pixel sampling、Webpack。

## 授權

[MIT](LICENSE)
