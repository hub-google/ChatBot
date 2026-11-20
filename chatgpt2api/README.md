# ChatGPT2API（ChatBot 專案內，獨立部署）

此目錄部署 [yukkcat/chatgpt2api](https://github.com/yukkcat/chatgpt2api) **v3.2.4** Docker 容器，提供 OpenAI 相容的文字、圖片 API 與管理介面。**不是 OpenAI 官方 API，也不能保證無限免費。**

不會修改 LINE ChatBot 目前正在使用的 Gemini 功能。只有明確設定遠端 HTTPS API 與 **CHATGPT2API_ENABLED=1**，才會讓 LINE 的 **#圖片** 使用此服務。

## Windows：一鍵啟動（最簡單）

1. 安裝並啟動 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，使用 Linux containers 模式。初次安裝可能需要 WSL 2。
2. 下載 GitHub 專案的 ZIP 並解壓縮，或用 Git clone 取得專案。打開 **chatgpt2api** 資料夾。
3. **雙擊 start-windows.cmd**。首次啟動會在本機建立強隨機密鑰、下載 Docker 映像、啟動服務、檢查認證，並開啟瀏覽器。
4. 管理介面：**http://127.0.0.1:3000**。依上游文件，在管理介面手動新增你有權使用的上游帳號／憑證。
5. 帳號配置完成後，**雙擊 test-image-windows.cmd**，嘗試產生一張測試圖片；成功檔案保存在 chatgpt2api/data/smoke-image.png（實際副檔名依結果可能是 jpg/webp）。

Windows 開啟服務時**需要 Docker Desktop 持續運行**。這些按鈕只啟動你自己電腦上的 API，預設只接受本機連線，不會自動對外公開。要讓雲端 Supabase LINE Bot 呼叫，還需要下一節的公開 HTTPS 服務。

系統金鑰只寫到本機 .env，不顯示在終端機，也不提交到 GitHub；帳號及生成檔案存於忽略清單中的本機目錄。**不要**將 .env、登入 Cookie、Session Token 或主金鑰貼進 GitHub Issue、LINE 或聊天室。

Windows 如要停止：

~~~powershell
cd chatgpt2api
docker compose down
~~~

## Linux：Docker 啟動

需要 Docker Engine + Compose v2：

~~~sh
cd chatgpt2api
sh scripts/setup.sh
docker compose up -d app
python3 scripts/smoke_test.py
~~~

scripts/setup.sh 自動建立本機 .env 隨機金鑰；管理介面僅在 http://127.0.0.1:3000。

**上游帳號設定完成後**，才執行真正產圖測試：

~~~sh
python3 scripts/smoke_test.py --image
~~~

若以 SSH 遠端管理，請建立安全通道：

~~~sh
ssh -L 3000:127.0.0.1:3000 user@SERVER
~~~

接著在本機瀏覽器開啟 http://127.0.0.1:3000。

## 對外 HTTPS API（遠端 LINE 機器人使用）

需要有能持續執行 Docker 的主機與公開連線。GitHub Pages 與 Supabase Edge Functions 本身不能代替此 Docker 容器；**本方案不使用 Cloudflare Workers**。

1. 為 Docker 主機準備公開 IPv4 與 TCP 80/443；若在家中電腦部署，還需確認防火牆、路由器轉發以及是否使用 CGNAT。
2. 建立 chatgpt2api.monsterport.com 的 DNS A 記錄，指向伺服器的公開 IPv4。
3. 在僅存於伺服器的 .env 設定：

~~~env
API_DOMAIN=chatgpt2api.monsterport.com
CHATGPT2API_BASE_URL=https://chatgpt2api.monsterport.com
~~~

4. 執行 docker compose --profile public up -d。Caddy 會申請 HTTPS 憑證。
5. 在伺服器執行 python3 scripts/smoke_test.py --base-url https://chatgpt2api.monsterport.com，再執行相同命令並加入 --image 真正產圖。

公開入口**僅允許** /v1/* 和 /files/*；管理後台留在本機。API 要求 Bearer Key。注意 /files/* 的圖片連結本身可供持有網址者下載，不要把它視為私人永久儲存空間。為 LINE 機器人建立獨立子金鑰，不要使用管理員主金鑰。

## 連接原有 LINE ChatBot（預設關閉）

部署並驗證 HTTPS 圖片接口後，在正確的 Supabase 專案 **Edge Function Secrets** 設定：

~~~env
CHATGPT2API_ENABLED=1
CHATGPT2API_URL=https://chatgpt2api.monsterport.com
CHATGPT2API_API_KEY=<LINE 專用 API Key>
CHATGPT2API_IMAGE_MODEL=gpt-image-2.6
~~~

呼叫邏輯位於 supabase/functions/line-ai-chatbot/image.ts。CHATGPT2API_ENABLED 沒有設為 1 時，仍使用原本 Gemini；使用 ChatGPT2API 遇到失敗也**不會自動改呼叫付費 OpenAI API**。

只有當上游服務正常、帳號已授權、HTTPS API 實測成功、LINE Bot 收到圖片，才能稱為端到端完成。

## 檢查與維護

- 主要本機檢查：python3 scripts/smoke_test.py（/v1/models + 錯誤金鑰拒絕）。
- 真實圖片測試：python3 scripts/smoke_test.py --image 或 Windows test-image-windows.cmd（需要可用上游帳號及額度）。
- 離線合約測試：python3 -m unittest discover -s chatgpt2api/tests -v（完全不消耗上游生圖額度）。
- CI：.github/workflows/chatgpt2api-check.yml 驗證 Windows PowerShell、Python、Compose、Deno adapter。CI 使用模擬服務，不宣稱真實圖片生成成功。
- 日誌：docker compose logs --tail=100 app。
- 備份：本機 data/、config.json、.env（加密保管），更新映像前先閱讀上游 changelog。

## 驗收狀態

- [x] 已提交部署設定、安全金鑰產生程式、Windows 一鍵啟動／測試、HTTPS 設定與 LINE adapter。
- [x] 已提交離線 API 合約測試及 CI。
- [ ] 真實主機 Docker 容器啟動與健康檢查。
- [ ] 具有合法存取資格的上游帳號加入後，真實圖片生成成功。
- [ ] 公開 HTTPS API 可從 Supabase 連入。
- [ ] LINE 實際成功收到圖片。

## 合規與成本說明

此服務逆向介接 ChatGPT 網頁，不屬於 OpenAI 官方 API，可能因上游更動失效，亦有帳號限用或封禁風險。自行部署轉接程式不等於免費取得上游計算資源。不要以自動註冊帳號、帳號池或規避限額機制取得未授權的無限額度，亦勿在不明服務輸入重要帳號的登入資料。
