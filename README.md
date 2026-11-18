# ChatBot — LINE AI 聊天機器人

以 Supabase Edge Function 接收 LINE Webhook；Gemma 負責日常聊天與資料摘要，Gemini API 提供語音／圖片功能。GitHub `main` 是**程式碼與 SQL 的唯一來源**。修改原始碼後再更新 Supabase，不以手動線上熱修補代替版本管理。**不使用 Cloudflare Worker，也不依賴本機電腦常駐。**

## 系統流程

```text
LINE 私訊 / 群組明確 @BOT
    ↓
index.ts：驗證 LINE X-Line-Signature、授權與入口分流
    ↓
messages.ts：Webhook 去重 + 保存原始對話
    ↓
tasks.ts：每個聊天室一筆持久化待回覆任務（revision）
    ├─ 普通文字 → generation.ts：Gemma 26B → Gemma 31B
    ├─ 需要最新資訊 → search.ts → generation.ts 用原本人設摘要 → 來源連結
    ├─ #說話 → generation.ts → voice.ts TTS → LINE 音檔
    └─ #圖片 → image.ts → Gemini 產圖 → LINE 圖片
    ↓
line.ts：有效 Reply Token 優先 Reply；逾時才在免費額度內 Push
    ↓
messages.ts：成功傳送後紀錄回覆／模型，避免已發送訊息重送
```

同聊天室的最新訊息會提升 `revision`，舊請求發送前需重新比對最新版。不同聊天室獨立處理。原始訊息保存在 `ChatBot_Line_對話紀錄`，最新 20 筆可作為生成上下文。群組只有真正 @BOT 才回覆，私訊可直接聊天。

## 程式模組（互相分工，不堆疊補丁）

| 模組 | 唯一責任 |
| --- | --- |
| `index.ts` | HTTP、LINE Webhook 與排程入口、受保護診斷 |
| `runtime.ts` | 型別、設定、Supabase REST、HMAC 與授權共用函式 |
| `messages.ts` | 對話寫入／讀取、Webhook 去重、歷史及計數 |
| `tasks.ts` | 待回覆佇列、重試、最新版本判定、生成與發送流程編排 |
| `line.ts` | 群組提及判定、LINE Reply／Push、免費 Push 安全保護 |
| `generation.ts` | GitHub 知識庫、Gemma 共用人設、資料摘要與唯一的來源格式化 |
| `search.ts` | 即時搜尋意圖、RSS、天氣主備來源、成功結果快取 |
| `voice.ts` | `#說話` 參數、Gemini TTS、MP3 與私有音檔儲存 |
| `image.ts` | `#圖片`、Gemini 圖片生成與私有檔案儲存 |
| `regression.test.ts` | 搜尋路由、人設摘要、來源安全、LINE 提及及簽章的回歸測試 |

沒有重新建立對話表，沒有改動其他專案的資料表或設定。

## AI 回覆與資料來源

**唯一標準流程：** 使用者發問 → 判斷是否需要最新資訊 → 取得外部資料 → **交給同一套 Gemma 人設**自然摘要 → 驗證天氣的重要數值 → 在最後附上實際資料來源。絕不將搜尋 API 原始文字直接灌入 LINE。

- **普通聊天：** 台灣繁體中文、簡短自然、帶點俏皮與網路梗，不採客服口吻；不會為「今天吃什麼」等日常閒聊額外查網路。
- **查專業知識：** 透過 `Data/index.json` 的關鍵字讀取 GitHub 參考檔；資料僅作參考，不能修改系統指令。
- **天氣：** 今日／明日／後天／大後天依台灣時間匹配**實際預報日期**。先查 Open-Meteo，稍後並行啟動 wttr.in 備援，採用第一份日期正確的資料。它們是預報，非中央氣象署實際測站觀測。兩個來源都失敗則將任務排程重試；不快取錯誤結果，也不編造天氣。
- **其他即時問題：** Bing 搜尋 RSS、Google 新聞 RSS、必要時維基百科背景資料。RSS 沒有服務保證，來源日期和即時性可能不完整。
- **自然語氣：** `generateGroundedAnswer` 統一呼叫原本的 Gemma 人設；`formatGroundedReply` 只接收模型正文與可信來源。如果模型拒答或說出錯誤天氣數字，使用簡短自然的已核對資料備援，而不是原始 API 版型。生成語音時，引用連結另用 LINE 文字附上，音訊不唸出 URL。
- **來源安全：** 外部文章、RSS 摘要與網頁內容皆視為不可信資料；輸出的來源網址以實際取得的來源為準，不使用模型憑空生成的連結。

## 指令

| 輸入 | 行為 |
| --- | --- |
| 一般文字 | Gemma 自然回覆；符合時效問題才搜尋 |
| `#搜尋 問題` | 強制搜尋，整理後附來源 |
| `#說話` | Gemini 以預設 `Leda` 聲線朗讀回答 |
| `#說話:Zephyr`、`#說話:Leda`、`#說話:Aoede` | 選擇支援的語音聲線 |
| `#圖片 描述` | Gemini 產生圖片；搜尋與語音不會取代產圖 |

## 排程、費用與安全

- **持久化重試：** Gemma 優先 `gemma-4-26b-a4b-it`，失敗切換 `gemma-4-31b-it`；暫時失敗可依原有 `2／4／8／15／30 秒`退避。Supabase `pg_cron` 每 30 秒檢查待回覆任務，`pg_net` 負責喚起 `line-ai-chatbot`；新訊息優先。
- **LINE 發送：** 40 秒內優先 Reply API；Reply Token 過期後才使用 Push，必須檢查免費額度並原子預留，現有保守上限為每月 190 則 Push。配額不可確認就不發付費 Push。
- **聊天次數：** 不再設程式自訂的每分鐘／每日對話上限；仍受模型、Supabase、LINE 官方免費配額與防濫用保護約束。
- **外部免費服務：** Open-Meteo 免費端點僅限符合其非商業使用政策的情況；公開 RSS／wttr.in 亦非無限資源。Gemma、TTS、產圖功能仍各自受 Google 免費配額限制，**不自動啟用付費 API**。
- **秘密：** LINE Channel Secret、Access Token、Gemini Key 存於 Supabase Vault，由 `ChatBot_Line_runtime_secrets` 提供。Webhook 必須驗證簽章，排程與診斷必須驗證 Vault 工作金鑰。密鑰不可寫入 GitHub、公開前端或 README。
- **資料：** 對話保留在原有表；私有語音／圖片以約 7 日有效的簽署網址發送。不要假設過期影音會立即清理，需監控儲存空間。

## 測試與部署

回歸測試（Deno 環境）：

```bash
deno test --allow-env supabase/functions/line-ai-chatbot/regression.test.ts
```

正式 Edge Function 具備受工作金鑰保護的**只讀**診斷入口：

- `GET /functions/v1/line-ai-chatbot?weather_probe=<編碼後的天氣問題>`：真正執行搜尋路由與天氣資料查詢。
- 加上 `&provider=backup`：強制測試 wttr.in 備援。
- 加上 `&render=1`：真的使用 Gemma 人設摘要並輸出 `rendered`，**不**向 LINE 使用者發送測試訊息。未持有排程金鑰必須收到 HTTP 403。

2026-11-18 正式驗證：Supabase `line-ai-chatbot` v25 `ACTIVE`；受保護的 `render=1` 測試「@BOT 後天台北天氣如何」回 HTTP 200，輸出自然聊天句子及實際來源；備援 `provider=backup` 回 HTTP 200，來源為 wttr.in；未授權回 HTTP 403。**這不等於近期真人 LINE 從 Webhook 到聊天畫面完整端到端的驗收**；那項仍需實際聊天新訊息紀錄確認。

### 變更原則

直接修改負責該功能的模組；不疊加第二套同義函式、額外的 Webhook、重複資料表或臨時例外分支。變更前先看現行程式，改完更新相對應回歸測試，先提交 GitHub `main` 再部署 Supabase，最後核對正式版本和實際功能。

## 跨平台 Chrome 聊天助手（2026-11-18）

新增 `chatbot-api`，共用現有 `generation.ts`、`search.ts` AI 引擎，與 LINE Webhook 分開部署。
Chrome 擴充功能見 `extension/`：配對碼一次性兌換裝置權杖、個別網站權限、逐站選取訊息／輸入框／發送鍵、AI 建議與手動填入。預設不自動發送；已取得站方許可時可以明確啟用自動發送。WooTalk 禁止自動發送，仍需符合其服務條款。所有原有 LINE 表格保留；跨平台使用獨立的 `ChatBot_Bridge_*` 表。

首次連線：管理者建立安全隨機配對碼，僅將 SHA-256 存於 `ChatBot_Bridge_pairs`，使用者在擴充功能內兌換設備權杖；Chrome 永不保存 Gemini 或 service_role 金鑰。可透過設置 `ChatBot_Bridge_devices.revoked_at` 撤銷裝置。

開發驗證：LINE 必須獨立回歸測試，`main` 程式與 SQL 為單一來源。正式環境舊的 LINE Edge Function 不因新增跨平台函式而被覆蓋。
