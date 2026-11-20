# ChatGPT2API（獨立部署，供 CHATBOT 選用）

本目錄部署現成開源 [yukkcat/chatgpt2api](https://github.com/yukkcat/chatgpt2api) **v3.2.3** Docker 容器，不修改現有 LINE ChatBot 的 Gemini 設定、LINE webhook 或資料庫。上游提供 Web 管理介面、OpenAI 相容文字及圖片 API。此專案**不是 OpenAI 官方 API**。

## 步驟一：在 Linux 主機部署（需要 Docker + Compose）

```sh
cd chatgpt2api
sh scripts/setup.sh
docker compose up -d app
python3 scripts/smoke_test.py
```

`scripts/setup.sh` 自動產生高強度 API 金鑰，僅存於本機 `.env`，不印出、不提交 GitHub。原始管理介面預設僅在主機 `http://127.0.0.1:3000` 開放。若遠端管理，使用 `ssh -L 3000:127.0.0.1:3000 user@SERVER`，再用本機瀏覽器開 `http://localhost:3000`。

在管理介面依上游文件手動加入可用的上游帳號／憑證（**不將密碼、Session Token 或 Cookie 放入 GitHub**）。沒有上游帳號時，API 可以啟動，但**無法真的生成圖片**。請自行評估非官方網頁逆向的服務條款與停權風險；不能保證不限次數或永遠免費。

## 步驟二：安全開放 HTTPS API（供 Supabase LINE BOT 呼叫）

1. 先準備可長期運作的 Linux 主機；若選 Oracle Always Free，要先有帳號並成功取得免費 VM，且不保證永不回收。
2. 建立 `chatgpt2api.monsterport.com` 的 DNS **A 記錄**，指向該主機的公開 IPv4；開放 TCP 80/443。
3. 在私有的 `.env` 設定 `API_DOMAIN=chatgpt2api.monsterport.com` 及 `CHATGPT2API_BASE_URL=https://chatgpt2api.monsterport.com`。
4. 執行 `docker compose --profile public up -d`，Caddy 自動申請 HTTPS 憑證。
5. 執行 `python3 scripts/smoke_test.py --base-url https://chatgpt2api.monsterport.com`。
6. 真正圖片端到端驗證：`python3 scripts/smoke_test.py --base-url https://chatgpt2api.monsterport.com --image`。

公開入口**只開放** `/v1/*`、`/files/*`；管理後台保持僅主機 loopback。前者仍由 Bearer 金鑰保護；`/files/*` 是帶不可預測檔案路徑的公開連結，切勿視為永久私人內容。建立專供 LINE 的**獨立子 API Key**，不要把管理員主金鑰放在 Edge Function。請勿公開提供沒有授權的生圖 API。

## 步驟三：啟用 LINE 的 #圖片（預設關閉）

`supabase/functions/line-ai-chatbot/image.ts` 已包含可選 ChatGPT2API adapter。僅當這四個環境變數齊備才會使用它：

```env
CHATGPT2API_ENABLED=1
CHATGPT2API_URL=https://chatgpt2api.monsterport.com
CHATGPT2API_API_KEY=<LINE 專用 API Key>
CHATGPT2API_IMAGE_MODEL=gpt-image-2.6
```

以上值請在 Supabase 專案的 **Edge Function Secrets** 設定，絕對不要提交到 GitHub、公開網站或記錄 log；機器人既有的 Gemini API 與 `#圖片` 路由都保留。預設未設定 `CHATGPT2API_ENABLED` 就仍使用原本 Gemini，不會改動線上行為。啟用後若 ChatGPT2API 失敗會回報錯誤／由既有排程重試，**不偷偷轉付費 OpenAI API**。

本地服務使用 SQLite（存在 `data/`），主機不可依賴短暫檔案系統；備份 `data/`、`config.json`、及本機保管的 `.env` 到加密位置。更新版本前先備份與閱讀上游 changelog。

## 驗收狀態

- 部署設定、金鑰產生腳本、HTTPS 保護設定、API 測試工具與 LINE adapter：已加入版本控制。
- 實際 Docker 啟動／上游帳號授權／圖片端到端測試／LINE 收到圖：**需要可用 Docker 主機及上游帳號，尚未驗證，不能稱為已上線。**

## 限制與合規

此方案使用第三方對 ChatGPT 網頁進行非官方介接。OpenAI 使用條款限制未授權的自動化擷取與規避限制。**不能宣稱合法無限免費，也不能用自動註冊／帳號池規避速率限制**。部署方負責上游使用資格、帳號安全與公平使用。
