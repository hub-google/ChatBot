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
