# 安全與隱私

這個工具處理的是你的個人財務資料。請務必遵守以下幾點：

1. **你的 repo 必須設為 Private。**
   `data/` 裡是你的持股、交易與資產數字，git 歷史也會保留。公開 repo 等於公開財務狀況。

2. **Vercel 一定要設登入密碼。**
   `middleware.js` 對整個網站（含 `data/*.json`）加上 HTTP Basic Auth，且**未設定
   `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` 時一律回 401**（fail-closed，不會意外公開）。
   部署後請確認開網站時會要求輸入帳密。

3. **資料永遠只在你自己的 repo 與 Vercel。**
   本專案沒有任何後端伺服器、沒有集中式資料庫，開發者看不到、也不保管你的資料。

4. **價格資料來源為公開 API**（TWSE／TPEX／Yahoo Finance），正確性不保證；
   本工具僅供個人記帳與數據呈現，不構成投資建議。

若發現安全問題，請透過 repo 的 issue 回報（勿在 issue 內貼出任何真實財務數字）。
