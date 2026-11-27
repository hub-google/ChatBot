# ChatGPT2API Windows（免 Docker、獨立執行）

本目錄是 ChatGPT 網頁版第三方介接工具的 **Windows 可攜式封裝及驗收程式**。它不是官方 OpenAI API，也不需要 LINE Bot、Supabase、Gemini、Docker 或 Python。上游核心採用 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) v2.1.0（固定 commit `d26fcb98ea0f15b73ef19ac753bacf0344ce33b2`），Go 編譯，在本機執行。原始專案 MIT 授權，建置產物保留授權文件。

## 取得可執行檔
1. 開啟此儲存庫 Actions → **ChatGPT2API Windows Portable** → 最新成功的執行。
2. 在 Artifacts 下載 `ChatGPT2API_Windows_NoDocker`，解開裡面的 ZIP 到私人資料夾。
3. 雙擊 `start-windows.cmd`。第一次啟動會於本機產生隨機管理 API Key（不公開、不上傳）。
4. 雙擊 `copy-admin-key.cmd` 複製本機管理金鑰，貼到開啟的本機管理畫面登入。
5. 依上游的帳號加入方式，在**本機**管理後台加入自己的有效帳號；未授權以前無法做真正的文字/圖片生成。
6. 雙擊 `test-api.cmd` 進行本機 API 認證測試；文字/生圖的真實測試請用 `test-api.cmd text` / `test-api.cmd image`（需帳號授權及可用額度）。
7. 關閉服務視窗並按 Enter 停止服務，或執行 `stop-windows.cmd`。

Web 管理畫面：<http://127.0.0.1:3000/>  
API Base URL：`http://127.0.0.1:3000/v1`  
可用介面依上游實際回傳 `GET /v1/models` 為準。

### 安全性
- 服務預設只監聽 `127.0.0.1`；不向網際網路公開管理畫面。
- 管理金鑰保存在解壓縮目錄的 `.local/admin-key.txt`，使用加密學安全隨機數在使用者自己的 Windows 電腦產生。不要公開、上傳或分享。
- 帳號憑證、SQLite 資料與聊天紀錄由上游服務保存於本機 `data/`；**不會經由 GitHub Pages 或前端原始碼儲存 API Key**。
- 更新前備份私人 `data/`、`config.yaml` 與 `.local/`；不要將這些內容提交到 GitHub。
- 上游是非官方網頁介接，可能因 ChatGPT 改版而失效，可能違反服務使用條款並帶來帳號限制風險。請審慎使用，不提供規避風控或無限額度的承諾。

### 驗收邊界
GitHub Actions 會檢查 Windows Go 建置、啟動、授權/拒絕無效金鑰、檔案完整性。**只有 Windows 使用者在自己的電腦加入有效帳號，才能證實真正的文字及圖片生成成功**。CI 離線測試不能冒充真實生成驗收。

歷史：這個功能曾寫入 `hub-google/ChatBot/chatgpt2api`，後續被移除。此版本以獨立資料夾和獨立 GitHub 分支進行維護，完全不更動 ChatBot 正式主線。