# 官方 Telegram / Discord 連接器

共用現有 CHATBOT 的 Gemma、知識庫、搜尋模組，不碰 LINE webhook。使用同一個 Supabase 專案及獨立的 ChatBot_Channel_messages。

## Telegram
- Function: chatbot-telegram
- URL: https://unapiwajmgqqtdkixaab.supabase.co/functions/v1/chatbot-telegram
- 在 Supabase Edge Function secrets 設定 CHATBOT_TELEGRAM_TOKEN、CHATBOT_TELEGRAM_WEBHOOK_SECRET。
- 透過官方 Bot API setWebhook 設定 URL 和 secret_token。BotFather 產生 token；**不要放在 GitHub**。
- 私訊直接聊天；群組只對 /ask 或 /chat 回答。使用者應知道這是機器人。
- **部署後仍需設定官方 Bot 帳號及 webhook 才能接收訊息。**

## Discord
- Function: chatbot-discord
- URL: https://unapiwajmgqqtdkixaab.supabase.co/functions/v1/chatbot-discord
- 在 Supabase Edge Function secrets 設定 CHATBOT_DISCORD_PUBLIC_KEY。
- 在 Discord Developer Portal 設定 Interactions Endpoint URL，註冊 CHAT_INPUT /ask 指令，參數 question (STRING/required)。
- 驗證官方 Ed25519 簽章與請求時間；在 3 秒內延遲回覆，完成 AI 後編輯原始訊息。
- 此版支援官方 Slash Command，**不是**任意訊息自動監聽。Discord 即時訊息需官方 Gateway 與長期連線平台。
- 部署後仍需 Discord 應用程式與 Public Key 才能啟用。

## 安全與限制
- 不要求自動登入 WooTalk；不模擬個人 Telegram/Discord 帳號。
- Telegram webhook 使用官方 X-Telegram-Bot-Api-Secret-Token。
- Discord 僅回應簽章有效的請求，避免任何人任意呼叫 AI。
- AI 服務免費配額不是無限；此專案不自訂每日/每分鐘聊天數量上限，也不啟用付費超額。
- 本模組為**官方憑證待接入**版本；須使用真實平台帳號做完整端到端驗收。
