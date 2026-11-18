# ChatBot：LINE AI 聊天機器人

GitHub 是程式碼與 SQL 的**唯一來源**；Supabase 是正式執行環境。修改先進 GitHub `main`，再部署 Supabase Edge Function。**不使用 Cloudflare Worker，也不依賴本機電腦長時間開機。**

## 系統架構

```text
LINE 使用者（私訊 / 群組 @機器人）
  │  LINE Webhook：驗證 X-Line-Signature
  ▼
Supabase Edge Function：line-ai-chatbot
  ├─ 以 webhookEventId 去重：ChatBot_Line_events
  ├─ 寫入完整對話：ChatBot_Line_對話紀錄（原有唯一對話表）
  └─ 更新該聊天室的一筆待回覆任務：ChatBot_Line_pending
         │  新訊息到達：revision + 1；舊回答作廢
         ▼
      Gemma 26B → Gemma 31B（失敗切換）
         ├─ 成功：先確認 revision 仍是最新，再發送
         │      ├─ LINE Reply API（優先，限有效 Reply Token）
         │      └─ LINE Push API（超時，且通過免費額度檢查）
         └─ 失敗：只記錄錯誤、安排下一次重試，不傳錯誤文案
                   ▲
                   │
      Supabase pg_cron 每 30 秒掃描是否有到期任務
      有任務才透過 pg_net 呼叫 Edge Function
      （worker 驗證金鑰放在 Supabase Vault）
```

## 單一聊天室的「新訊息優先」規則

1. 私訊預設會回應文字；群組／多人聊天室僅在明確 @本機器人時才生成回覆。其他訊息也記錄，但不建立回覆任務。
2. 每個聊天室僅有 **1 筆未完成或最近完成的任務狀態**，以雜湊後的 `user_hash` 當主鍵。不同聊天室互不阻塞，聊天內容保留在原本的 `ChatBot_Line_對話紀錄`。
3. 若第一句正在因 Google 503 失敗重試，第二句又進來：寫入第二句、將任務的 `revision` 加一，並立即安排新任務。新任務會讀取最近 **20 筆**對話作為上下文；舊請求即使稍後取得答案，發送前也必須再次比對版本，舊版本不可發送。
4. 已經成功發出的訊息不會撤回；若新訊息剛好在 LINE HTTP 發送期間到達，兩個遠端系統之間無法保證絕對原子的取消。已使用資料庫條件轉態把競爭窗口縮到發送期間。

## AI 重試策略

每輪優先使用 `gemma-4-26b-a4b-it`，失敗就嘗試 `gemma-4-31b-it`；兩個都失敗才算一輪失敗。每個模型請求最多約 9.5 秒。

| 失敗輪次 | 距離該輪失敗多久後重試 | 說明 |
| --- | --- | --- |
| 1 | 2 秒 | 同一輪已嘗試兩個模型 |
| 2 | 4 秒 | 自動接續 |
| 3 | 8 秒 | 自動接續 |
| 4 | 15 秒 | 仍未成功就交給持久化任務 |
| 5 以後 | 30 秒 | pg_cron 每 30 秒喚醒，實際可能略有延遲 |

Webhook 背景任務最多連續跑 4 輪，且約 43 秒內不再啟動新的輪次；超過後由 Supabase 排程接力。**不限制總重試次數，但每次重試都會計入外部 API 用量。**

例外：遇到 HTTP 429 先暫停約 2 分鐘；403 暫停約 1 小時。原有保護額度仍保留：同聊天室每分鐘 12 則、每天 100 則，全站每天 1,200 則 AI 回覆；達上限先延後重試，不向使用者推播「額度用完」等制式錯誤訊息。對話量若大幅增加，必須重新評估這些上限與 Google 模型免費配額。

## LINE 回覆與費用保護

- **40 秒內**（以任務接收時間判斷）優先使用 Reply API。若 LINE 回報 Reply Token 失效（HTTP 400），改檢查 Push API。
- 超過 40 秒後使用 Push API，但**必須先檢查 LINE OA 的每月總額度及已使用量**；僅接受可確認的 `limited` 配額。對 Push 採更保守的 **190 則／月安全上限**，並在 Supabase 以原子預留額度，避免併發大量補發。
- LINE OA 若不能確認免費額度，**不發 Push、不自動花錢**；任務保留，每 6 小時重新檢查。用戶不會收到「AI 卡住」的訊息。
- Push 使用穩定的 `X-Line-Retry-Key`，降低網路重試造成重複發送的機率。
- 若 Reply API 的網路結果不明（例如送出後連線中斷），標記 `uncertain`，**不盲目再送一次**。跨 LINE 與資料庫的「絕對只發一次且絕不漏發」無法保證，此狀態需要依日誌人工確認。
- 由於 Push API 受到 LINE OA 套餐規則限制，免費額度耗盡時**不能保證立即補發**。不會為了回覆而偷偷產生付費請求。

## 資料表

| 資料表 | 用途 | 保存規則 |
| --- | --- | --- |
| `ChatBot_Line_對話紀錄` | 唯一聊天內容與 AI 回應紀錄（含原始七欄及必要索引欄） | 保留對話，不因重試重複新增 |
| `ChatBot_Line_events` | LINE Webhook 去重及處理狀態 | 依既有邏輯清理過期事件收據 |
| `ChatBot_Line_pending` | 各聊天室最後待回覆事件、修訂版號、重試次數、Reply Token、目標 LINE ID、時間與錯誤代碼 | **不複製訊息文字**；新訊息更新同一列 |
| `ChatBot_Line_push_reservations` | 每個 LINE 計費月的 Push 安全預留計數器 | 極小容量的月統計 |

待回覆任務只允許 Supabase `service_role` 讀寫，啟用 RLS，拒絕 `anon`／`authenticated` 存取。LINE Channel Secret、Access Token 與模型 API Key 保存在既有 Supabase Vault，不應寫入 GitHub 或 README。

## 任務狀態

- `pending`：等待下次執行（`next_retry_at`）。
- `processing`：某次 Edge Function 已領取，110 秒租期到後可重新領取。
- `sending`：通過最新版本檢查，正在呼叫 LINE。若在此階段崩潰，需人工確認是否已送出；避免無法判斷的重發。
- `sent`：LINE API 已回報成功。
- `uncertain`：LINE Reply API 的結果不明，不再自動重發，避免重複訊息。

## GitHub 原始碼 / 部署

- `supabase/functions/line-ai-chatbot/index.ts`：正式 Webhook、對話上下文、雙模型、佇列與重試、LINE Reply/Push。
- `supabase/sql/chatbot_line_persistent_retry.sql`：建立任務表、索引、行級安全、原子入列／領取、Push 額度預留及 Vault 工作金鑰。
- `supabase/sql/chatbot_line_retry_schedule.sql`：`pg_cron` 每 30 秒檢查工作，存在到期任務時才用 `pg_net` 呼叫 Edge Function。
- `supabase/sql/chatbot_line_single_table.sql`：舊版兩份顯示物件整併至一份對話表的資料庫變更紀錄。

**執行環境：** Supabase 專案 `unapiwajmgqqtdkixaab`；Edge Function 名稱 `line-ai-chatbot`；`verify_jwt=false` 以接收 LINE Webhook，但會強制驗證 `X-Line-Signature`。排程入口則要求 Vault 中的 `chatbot_line_scheduler_key`，未授權不可啟動背景工作。

正式部署時應依序完成：先套用 SQL migration → 部署 Edge Function → 建立 pg_cron 排程 → 檢查健康狀態與任務資料；程式修改同步回 `main`。沒有程式碼或 SQL 版本更新，不要只在 Supabase 手動改動造成版本漂移。

## 驗收與除錯

查詢任務狀態（**不要公開包含使用者 ID 或 Reply Token 的整列資料**）：

```sql
SELECT status, attempts, error_code, count(*) AS tasks
FROM public."ChatBot_Line_pending"
GROUP BY status, attempts, error_code
ORDER BY tasks DESC;
```

確認排程：

```sql
SELECT jobid, jobname, schedule, active
FROM cron.job WHERE jobname='chatbot-line-retry';
```

檢查任務異常：

```sql
SELECT count(*) FILTER (WHERE status='pending') AS pending,
       count(*) FILTER (WHERE status='processing') AS processing,
       count(*) FILTER (WHERE status='uncertain') AS uncertain
FROM public."ChatBot_Line_pending";
```

邊界測試應涵蓋：Google 503→恢復、長時間超時→Cron 恢復、同聊天室新訊息覆蓋舊修訂版、跨聊天室並行、LINE Reply Token 過期、Push 額度不足、Webhook 重送去重、Worker 未授權請求拒絕、資料庫中斷恢復。測試結果須以實際記錄為準，不應把部署成功視為所有實際情境已通過。


## 2026-11-18 上線驗證紀錄

已完成（正式 Supabase）：
- Edge Function `line-ai-chatbot` **v11 ACTIVE**；GitHub `main` 與正式部署內容同步。
- `chatbot-line-retry` 排程 **job 28／30 秒**，連續執行紀錄 `succeeded`；無到期任務時不呼叫 Edge Function。
- 使用不含任何真實使用者資訊的暫存任務，成功走過 **Vault 工作金鑰 → HTTP 200 → 資料庫 claim → 重新排程**，並已刪除測試任務。
- 使用合法 HMAC 簽章測試非聊天事件，LINE Webhook 正式入口回應 **HTTP 200**，沒有向任何使用者發送測試訊息。
- 資料庫交易測試：第二句提高版本號後，舊版本不能再作為處理中的最新版；匿名角色無法執行排程 RPC 或讀取待回覆表。
- SQL migration 與 cron 排程皆存入 GitHub；既有聊天紀錄未搬移或刪除。

尚未以實際 LINE 使用者確認：Google 503 多輪失敗後恢復的完整聊天、兩則訊息快速接續、超過 Reply Token 有效期的 Push 實際投遞與不同 LINE OA 套餐的免費額度行為。**這些情境不應標成已通過。**


## #說話：可愛少女音語音回覆（2026-11-18）

預設仍是文字聊天。**只有訊息中包含 `#說話`** 時，先移除該指令再交給 Gemma 產生文字回答，例如 `今天台北天氣怎樣 #說話`。若在 LINE 群組或多人聊天室，仍需真正 @ 機器人；未 @ 不回覆，也不合成語音。

1. Gemma 回答文字 → Gemini API `gemini-2.5-flash-preview-tts`（預設 `Zephyr`，清亮活潑；可選 `Leda`、`Aoede`）→ 24 kHz PCM。
2. 透過 `npm:@breezystack/lamejs@1.2.7` 將 PCM 轉為 LINE 接受的 MP3；以 `npm:@supabase/supabase-js@2.78.0` 上傳至 Supabase Storage 私有 bucket `chatbot-line-voice`。
3. 取得約 7 日有效的簽署音檔網址後，組成 `{type:"audio",originalContentUrl,duration}`，優先交由 LINE Reply API 發送；現有佇列回覆逾時時依原有免費 Push 安全限制處理。
4. **Google TTS API 實際回傳配額不足（429、明確配額 403）**，不丟失 Gemma 回答，改傳：
   `沒有Token說話了，只能打字回覆你啦。\n`＋原回答。
5. 如果 TTS 空音檔、轉碼、儲存或其他非額度錯誤，改傳 `語音暫時無法送出，先用文字回覆你：\n`＋原回答。
6. 成功音訊用 `AI 模型` 欄加註實際聲線（例如 `TTS:Zephyr`）；文字降級時儲存實際發送的提示句及原回答。音訊檔大小上限約 270 KB，僅持有簽署網址者可取得，逾 7 日的音檔採用機會式清理（若長期沒有新語音流量，舊檔可能延後清理，需監控 Storage 用量）。

聲線切換：`你好呀 #說話`（預設 Zephyr）、`你好呀 #說話:Leda`、`你好呀 #說話:Aoede`。冒號可用半形或全形，大小寫不限；聲線指令會從真正的提問中移除，仍只產生一次語音，沒有額外產音試聽請求。語氣改為台灣華語自然聊天、有笑意、避免機械朗讀；TTS 提示詞只能引導表現，無法保證每次都完全相同。

主要程式：`supabase/functions/line-ai-chatbot/index.ts` 與 `supabase/functions/line-ai-chatbot/voice.ts`。**不修改 GitHub `Data` 專業知識檔案或其觸發規則。**

**驗證：** 已實測 Gemini TTS 回傳實際 PCM、轉換成約 4.5 秒 / 36 KB 的 `audio/mpeg`、私有簽署 URL HTTP 200、LINE 音訊 Reply 物件官方驗證 HTTP 200。未取得真實使用者的 LINE Reply Token，因此**尚未驗證語音真正送達 LINE 聊天室**。部署版 `line-ai-chatbot` 已移除自行設定的每日 200 次限制。

**成本提醒：** Gemini TTS 的免費層級、Supabase Storage 容量及流量都有限制；**不設自訂每日語音次數上限**，只依 Google API 實際回傳的配額錯誤切換文字。高流量的零成本仍需監控。沒有啟用付費模型或 Cloudflare Worker。

## #圖片：Gemini API 產圖（2026-11-18）

- 使用者輸入如 `畫一隻白色貓 #圖片`，會先移除 `#圖片`，將剩餘描述送到 `gemini-2.5-flash-image:generateContent`，採用 `TEXT`、`IMAGE` 回傳模式。若同時包含 `#說話`，以產圖優先。
- Gemini 真正回傳圖片後，使用 Supabase Storage 私有 Bucket `chatbot-line-image` 儲存，建立七日有效的簽署 URL；透過現有 LINE Reply API（逾時則由原有免費 Push 安全邏輯處理）回傳 LINE `image` 訊息，圖片網址與預覽網址一致。
- 私訊可直接使用，群組仍需真正 @機器人。維持原有聊天室排隊、訊息去重與防舊訊息覆蓋機制；圖片不經 Gemma 文字回答模型轉述。
- **不設定自行發明的每日產圖次數上限，也不啟用任何付費方案。** Gemini API 確實回傳 429／配額不足時會以文字回覆「Gemini 產圖額度不足，這次無法產圖。」而非假裝已成功產圖。其他失敗則回覆「Gemini 產圖暫時失敗，請稍後再試。」
- **真實免費配額核對：** 2026-11-18 已以目前 LINE ChatBot Vault 中的 Google API Key 分別呼叫 `gemini-2.5-flash-image` 與 `gemini-3.1-flash-lite-image`，Google 都回傳 HTTP 429 並明確寫入 `generate_content_free_tier_requests limit: 0`。這是 Google 端配額設定，程式碼不能解除。只有該 API Key 獲得實際可用的免費產圖配額後才可能真正回圖；沒有啟用計費。
- `image.ts`：Gemini 圖片生成、MIME／尺寸驗證、Supabase Storage 上傳與過期清理。圖片儲存及簽署 URL 並非永久圖庫（過期檔案採用機會式清理），需要另外規劃長期保存。
- 目前已驗證 Gemini 免費配額回應、LINE 圖片訊息物件及 Edge Function 部署；尚未完成在有免費額度時真正生成圖片並傳送至真人 LINE 的端到端驗收。

## 自動即時網路搜尋（2026-11-18）

- **自動啟用：** 含即時／時效性查詢（例如「今天台北天氣」、「台積電最新新聞」、「現在的股價」）時搜尋；也可以強制輸入 `#搜尋 查詢內容`。一般聊天維持 Gemma 原本流程，不額外呼叫搜尋 API。
- **氣象（2026-11-18 修正）：** 台灣縣市查詢以 Open-Meteo 免費開放 API 取得今天、明天、後天或大後天的**對應日期**預報（每天高／低溫、天氣型態、最高降雨機率），今天另列目前氣溫與資料時間。天氣直接以已取得的 JSON 數值格式化回覆，**不再交給 Gemma 猜測或回答「無法看即時天氣」**。這是氣象模式推估，非中央氣象署測站實際觀測。沒有辨識到縣市時會詢問地點；昨天等過去日期不會誤用今天資料。Open-Meteo 的免費端點限非商業用途，並有使用量限制，不保證商業大流量。
- **一般網路搜尋：** 以 Bing 公開 RSS 搜尋結果為主、Google 新聞 RSS 為輔；新聞查詢反過來優先 Google 新聞 RSS；一般查不到再以中文維基百科補充背景。對外顯示至多兩筆實際來源網址。公開 RSS 端點非有 SLA 的正式 Search API，搜尋結果可能不即時、不完整，或被來源網站限制。
- **信任與錯誤處理：** 外部搜尋摘要僅作為資料而不是指令，Gemma 照原本的人格回應；當網路搜尋全失敗，回「目前無法取得可核對的即時資訊，我先不亂猜。晚點再問我一次。」而不是用舊知識假裝新資料。即時股價、選舉、比數等資訊仍要核對原始官方來源。
- **免費優先：** 沒有綁定付費搜尋服務、Google Search Grounding 計費功能或 Cloudflare Worker；不會因為流量升高自動轉換付費 API。搜尋來源可能封鎖、限流或中斷，免費不等於無限額度。
- **資源控制：** RSS 請求超時約 3.9 秒、氣象約 3.9 秒；有效結果於單一 Edge Function 執行個體記憶體中暫存 3 分鐘（天氣 5 分鐘），錯誤暫存 25 秒。沒有新增資料表或永久儲存搜尋內容，Edge Function 執行量及 Google 原本的文字回答模型仍受 Supabase／Google 免費配額限制。
- **程式碼：** `supabase/functions/line-ai-chatbot/search.ts`（判斷需否查詢、搜尋與來源整理）、`index.ts`（接入已存在的聊天／重試／LINE 發送流程）。已部署 `line-ai-chatbot` v20（天氣日期修正＋受保護的只讀搜尋驗證入口）。
- **驗證：** 正式 Supabase v18 ACTIVE；服務健康檢查 HTTP 200、已設定機密；由 Supabase 網路對 Open-Meteo、Bing RSS、Google 新聞 RSS 實測 HTTP 200，分別取得氣象 JSON／10 筆 Bing RSS 項目／100 筆 Google 新聞 RSS 項目。**尚未透過真人 LINE 聊天驗收完整「訊息→搜尋→Gemma 回覆→LINE 發送」流程**；來源可用性可能隨時改變。

### 2026-11-18 截圖問題修復與驗收

- 真實聊天紀錄顯示 12:36「@BOT 後天台北天氣如何」獲得無法查天氣的回覆，`AI 模型` 僅有 Gemma 名稱，沒有網路查詢記號；因此前一版的已部署／來源 API 200，**不足以證明 LINE 實際回覆已使用搜尋**。
- 現在使用 `requestedForecastDay` 解析明天／後天／大後天，從 Open-Meteo 的 `daily.time` 與相同索引的每日欄位取數值，直接輸出日期、氣溫、降雨機率、來源；避免把今日氣溫錯當後天。
- 由 Supabase 端呼叫**正式部署的 ChatBot `GET ?weather_probe=...` 受保護入口**，使用原句 `@BOT 後天台北天氣如何`，回傳 HTTP 200、`routed:true`、`kind:weather`、`status:ok`、11/20 對應預報。`明天台中天氣如何` 與 `今天台北天氣如何` 也回傳相應預報，未帶工作金鑰的測試請求回 HTTP 403。此探針不寫對話、不消耗 Gemma、不發 LINE；**仍需真人 LINE 重新測試新訊息**，驗證資料庫 `AI 模型` 欄為 `Open-Meteo：forecast`，不可把內部驗收冒充真人 LINE 投遞驗收。

### 只讀天氣診斷入口（授權保護）

- `GET /functions/v1/line-ai-chatbot?weather_probe=<已編碼的天氣問題>`：必須帶 `x-chatbot-worker`，與既有 Supabase Vault 排程密鑰一致才可執行；沒有授權會回 HTTP 403。
- 回應僅包含路由結果、來源類型、查詢狀態和可公開的氣象預報，不含任何密鑰、LINE ID 或私人聊天記錄。僅允許天氣相關問題且限制問題長度。
- 供後續查證「程式有部署，但實際路由沒有進搜尋」問題使用；不影響正式 LINE Webhook 流程。

## 2026-11-18 13:07 修正：LINE 天氣查詢逾時

**根因查證：** 使用者 12:53 的真實 LINE 訊息有進入 `line-ai-chatbot`。資料庫的實際回覆模型為 `Web Search：來源不可用`，並非忘記啟用路由。正式 `function_logs` 的 04:53:51 UTC 訊息為 `chatbot_weather_fetch_failed Signal timed out.`：Open-Meteo 一次約 4.8 秒超時，程式就把「目前無法取得……晚點再問」當正式回答送出。

**修正（正式 v21 ACTIVE）：**
- `search.ts` 的天氣 API 改成 **Open-Meteo + wttr.in 獨立雙來源備援**。先發主來源，500 毫秒仍未完成就並行啟動備援，採用第一個成功且有正確日期的資料；主來源超時不再直接回覆失敗。
- 嚴格檢查台灣當地預報日期：今天／明天／後天／大後天。wttr.in 僅提供三天，查大後天必須由 Open-Meteo 提供，若暫不可用則維持 pending 重試，不謊報日期。
- 只有 **成功結果** 才寫入記憶體快取，不能快取失敗結果污染後續重試。
- `index.ts` 中兩來源皆不可用時，使用原本有持久化的 `reschedule()` 排程重試，保留最新訊息優先及原本 LINE Reply／免費 Push 安全額度檢查，**不再把網路超時當正式文字回答送出**。
- 診斷 GET 的 `provider=backup` 只限帶有效工作金鑰，能驗證備援來源；正常 LINE 不需額外參數。

**實際驗收：**
- 正式部署 v21：`ACTIVE`。
- 正式受保護 Edge 入口 `weather_probe=後天台北天氣如何` HTTP 200：`routed=true,status=ok,provider=Open-Meteo`，日期 11/20，來源與數值完整。
- 正式受保護 Edge 入口加 `provider=backup` HTTP 200：`routed=true,status=ok,provider=wttr.in`，日期 11/20，氣溫、降雨機率等資料完整；主來源刻意跳過的情形，備援確實成功。
- 以既有 12:53 群組目標，依 LINE OA 現有免費方案上限／預留額度發送 **一則修復實測訊息**；Messaging API Push 回 HTTP 200，回傳 `sentMessages`，代表 LINE 接受訊息。此為由 Supabase 直接透過 LINE Push API 的實際送出驗證，不是虛構使用者訊息；此次消耗一則可計費推播。
- **限制：** 尚未有新的一則由真人 LINE @BOT 觸發 v21 的完整 Webhook→佇列→天氣查詢→LINE Reply 實測記錄，因此不能把上述路由／Push 分別測通說成整條實際觸發流程百分之百通過。
