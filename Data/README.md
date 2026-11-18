# ChatBot 知識庫（Data）

這個資料夾是 LINE ChatBot 的**專業知識檔案來源**，不是儲存私人聊天紀錄的地方。聊天紀錄儲存在 Supabase。

## 新增知識

1. 在本資料夾放入可直接讀取的 UTF-8 `.md`、`.txt`、`.csv` 或 `.json`。
2. 在 `index.json` 的 `entries` 新增一筆規則。例如：

```json
{
  "entries": [
    {
      "keywords": ["醫院", "門診", "掛號"],
      "path": "hospital.md"
    },
    {
      "keywords": ["職域", "醫護公會"],
      "path": "worksite.csv"
    }
  ]
}
```

LINE 訊息包含關鍵字時，機器人會從 `https://raw.githubusercontent.com/hub-google/ChatBot/main/Data/` 讀取對應檔案做為回答參考。一次最多讀取兩筆匹配，內容有長度限制。不匹配就使用一般閒聊模式。

## Excel 檔案

目前 `所有職域資料.xlsx` 的 GitHub blob **只有 CRLF 換行（2 bytes）**，不是有效的 XLSX 工作簿。已原樣保留，沒有覆蓋。

直接放入有效的 Excel 工作簿，**目前的 Edge Function 也不會自動解析 XLSX**；需轉換成 CSV/JSON 後在 index 註冊，或另外加入安全的工作簿解析流程。請勿將 API 金鑰、LINE Token、個資或實際聊天紀錄提交到此公開倉庫。

## Supabase 對話格式

Supabase `public.line_ai_messages` 保存原始紀錄及內部識別欄位。`public.line_ai_chat_log_sheet` 提供七個和舊 Google Sheet 一模一樣的欄位：

對話時間｜群組名稱｜群組 UUID｜發送者暱稱｜發送者 UUID｜對話內容｜AI 模型。

權限：僅後端 service_role 可以讀寫（RLS 啟用，沒有對匿名使用者公開）。原有訊息不刪除；部分舊紀錄沒有 LINE UUID、暱稱、模型資訊，無法倒推的欄位保留空白。
