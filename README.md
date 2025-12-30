# Telegram 关键词自动回复 Bot (Cloudflare Workers)

一个基于 **Cloudflare Workers + Telegram Bot API** 的自动回复机器人，  
支持 **关键词匹配、格式化回复（代码 / 粗体 / 链接等）**，  
并使用 **KV 存储规则 + ctx.waitUntil 实现非阻塞延时删除消息**。

---

## ✨ 功能特性

- ✅ 关键词自动回复
- ✅ 多关键词支持（`||` 分隔）
- ✅ **完整保留 Telegram 格式（entities）**
  - 行内代码 / 代码块
  - 粗体 / 斜体 / 下划线
  - 链接 / mention
- ✅ 群管理员 & 全局管理员权限控制
- ✅ 群聊 / 私聊自动区分
- ✅ **延时删除消息（不阻塞回复）**
- ✅ 防刷冷却（按 *用户 + 群*）
- ✅ Cloudflare KV 持久化存储
- ✅ 无服务器、零运维

---

## 🚀 技术栈

- **Cloudflare Workers**
- **Telegram Bot API**
- **Cloudflare KV**
- JavaScript（ES Modules）

---

## 📦 部署

### 1️⃣ 创建 Telegram Bot

在 Telegram 中联系 `@BotFather`：

```text
/start
/newbot
```

### 2️⃣ Cloudflare Workers 环境变量

在workers中配置以下变量

| 变量名            | 说明                         |
| -------------- | -------------------------- |
| `BOT_TOKEN`    | Telegram Bot Token 示例：123456:ABCDEF  |
| `BOT_USERNAME` | 机器人用户名（不含 @）示例：your_bot |
| `ADMIN_IDS`    | 全局管理员 Telegram ID（多个用逗号分隔）示例：["123456","123456"] |


### 3️⃣ 绑定 KV Namespace
创建一个KV储存
绑定变量为 *BOT*

### 4️⃣ 配置telegram bot
部署完成后浏览器访问

`https://api.telegram.org/bot<bot_token>/setWebhook?url=https://<wokers地址>`

设置Webhook就可以使用了

