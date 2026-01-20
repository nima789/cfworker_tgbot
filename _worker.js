const TELEGRAM_API = "https://api.telegram.org/bot";

export default {
  async fetch(request, env, ctx) {
    try {
      const BOT_TOKEN = env.BOT_TOKEN;
      const BOT_USERNAME = env.BOT_USERNAME; // 例如 xzcd_bot
      const ADMIN_IDS = parseAdminIds(env.ADMIN_IDS); // "123" or [".."]
      const TELEGRAM_RULES = env.BOT; // KV

      const update = await request.json();
      if (!update?.message) return new Response("OK");

      const msg = update.message;
      if (msg?.from?.is_bot) return new Response("OK");

      const chatId = msg.chat.id;
      const text = msg.text || "";
      const messageId = msg.message_id;
      const userId = String(msg.from.id);
      const isPrivateChat = msg.chat.type === "private";

      // 命令解析：忽略 @botname
      const allCommand = (text.split(/\s+/)[0] || "").trim();
      const command = allCommand.includes("@") ? allCommand.split("@")[0] : allCommand;
      const targetBot = allCommand.includes("@") ? allCommand.split("@")[1] : null;

      if (targetBot && targetBot !== BOT_USERNAME) return new Response("OK");

      // 权限校验：/start /help 放行，其余 "/" 命令需要 admin
      if (command.startsWith("/") && command !== "/start" && command !== "/help") {
        const ok = await isAdmin({ userId, chatId, isPrivateChat, ADMIN_IDS, BOT_TOKEN });
        if (!ok) {
          ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
          return sendMessageDelete({
            BOT_TOKEN,
            chatId,
            payload: { text: "❌ 你没有权限执行此命令。" },
            ms: 5000,
            ctx,
          });
        }
      }

      // 命令路由
      if (command.startsWith("/")) {
        if (command === "/add") {
          return handleAddCommand({ msg, chatId, messageId, TELEGRAM_RULES, BOT_TOKEN, ctx });
        }
        if (command === "/del") {
          return handleDelCommand({ text, chatId, messageId, TELEGRAM_RULES, BOT_TOKEN, ctx });
        }
        if (command === "/list") {
          return handleListCommand({ chatId, messageId, TELEGRAM_RULES, BOT_TOKEN, ctx });
        }
        if (command === "/listAll") {
          return handleGlobalListCommand({ chatId, messageId, TELEGRAM_RULES, BOT_TOKEN, isPrivateChat, ctx });
        }
        if (command === "/admin") {
          return handleAdminCommand({ chatId, messageId, isPrivateChat, BOT_TOKEN, ctx });
        }
        if (command === "/start") {
          return handleStartCommand({ chatId, messageId, isPrivateChat, BOT_TOKEN, ctx });
        }
        if (command === "/help") {
          return handleHelpCommand({ chatId, messageId, isPrivateChat, BOT_TOKEN, ctx });
        }

        ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
        return sendMessageDelete({
          BOT_TOKEN,
          chatId,
          payload: { text: "❌ 未知命令，输入 /help 查看帮助。" },
          ms: 6000,
          ctx,
        });
      }

      // 普通消息：自动回复
      return handleAutoReplyAndDelete({ msg, chatId, messageId, userId, TELEGRAM_RULES, BOT_TOKEN, ctx });
    } catch (e) {
      console.error(e);
      return new Response("Bad Request", { status: 400 });
    }
  },
};

// --------------------- utils ---------------------

function parseAdminIds(value) {
  if (!value) return [];
  try {
    if (value.trim().startsWith("[")) return JSON.parse(value).map(String);
  } catch {}
  return value.split(",").map(s => s.trim()).filter(Boolean);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeKeywords(raw) {
  // 支持关键词用 || 分隔；回复不支持 ||（你已确认不要）
  const arr = raw
    .split("||")
    .map(s => s.trim())
    .filter(Boolean);

  // 去重 + 长度降序（减少误触发）
  const uniq = Array.from(new Set(arr));
  uniq.sort((a, b) => b.length - a.length);
  return uniq;
}

function pickOne(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function isRuleReplyObject(x) {
  return x && typeof x === "object" && typeof x.text === "string" && Array.isArray(x.entities);
}

// 把 message.entities 中属于 reply 区间的实体抽出来，并把 offset 改成相对 reply 的 offset
function extractReplyEntities(messageEntities, replyStartOffset) {
  if (!Array.isArray(messageEntities) || messageEntities.length === 0) return [];
  return messageEntities
    .filter(e => typeof e.offset === "number" && typeof e.length === "number" && e.offset >= replyStartOffset)
    .map(e => ({ ...e, offset: e.offset - replyStartOffset }));
}

// --------------------- admin ---------------------

async function isAdmin({ userId, chatId, isPrivateChat, ADMIN_IDS, BOT_TOKEN }) {
  if (ADMIN_IDS.includes(userId)) return true;

  if (isPrivateChat) {
    await sendMessage({
      BOT_TOKEN,
      chatId,
      payload: { text: "请将bot添加到群组使用。" },
    });
    return false;
  }

  const admins = await getGroupAdmins({ chatId, BOT_TOKEN });
  return admins.includes(userId);
}

async function getGroupAdmins({ chatId, BOT_TOKEN }) {
  const res = await fetch(`${TELEGRAM_API}${BOT_TOKEN}/getChatAdministrators`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId }),
  });

  const data = await res.json();
  if (data.ok) return data.result.map(a => String(a.user.id));
  console.error("getChatAdministrators failed:", data);
  return [];
}

// --------------------- handlers ---------------------

async function handleAddCommand({ msg, chatId, messageId, TELEGRAM_RULES, BOT_TOKEN, ctx }) {
  const text = msg.text || "";

  // 只支持：/add 关键词===回复
  const sep = text.indexOf("===");
  if (!text.startsWith("/add ") || sep === -1) {
    ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
    return sendMessageDelete({
      BOT_TOKEN,
      chatId,
      payload: { text: "❌ 格式错误！正确格式: /add 关键词1||关键词2===回复内容\n（回复不支持 || 多条）" },
      ms: 7000,
      ctx,
    });
  }

  const left = text.slice(5, sep).trim();
  const replyText = text.slice(sep + 3).trim();

  const keywords = normalizeKeywords(left);
  if (keywords.length === 0 || !replyText) {
    ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
    return sendMessageDelete({
      BOT_TOKEN,
      chatId,
      payload: { text: "❌ 关键词或回复不能为空。" },
      ms: 6000,
      ctx,
    });
  }

  // ✅ 保存 reply 的 entities（避免 ` 代码 ` 被 Telegram 抽成 entities 导致 KV 里丢失反引号）
  const replyStartOffset = sep + 3;
  const entities = extractReplyEntities(msg.entities || [], replyStartOffset);

  const ruleKey = `rules_${chatId}`;
  const existingRules = JSON.parse((await TELEGRAM_RULES.get(ruleKey)) || "[]");

  // signature：用排序后关键词稳定去重
  const signature = [...keywords].sort((a, b) => a.localeCompare(b)).join("||");

  const idx = existingRules.findIndex(r => r.signature === signature);

  const newRule = {
    signature,
    keywords,                 // 已做长度降序
    reply: { text: replyText, entities }, // 只存一条回复（含格式）
    updatedAt: Date.now(),
  };

  if (idx >= 0) existingRules[idx] = newRule;
  else existingRules.push(newRule);

  await TELEGRAM_RULES.put(ruleKey, JSON.stringify(existingRules));

  // 删用户命令（后台）+ 回复（并延时删）
  ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
  return sendMessageDelete({
    BOT_TOKEN,
    chatId,
    payload: { text: "✅ 规则已添加成功！（已保留格式）" },
    ms: 4000,
    ctx,
  });
}

async function handleDelCommand({ text, chatId, messageId, TELEGRAM_RULES, BOT_TOKEN, ctx }) {
  const match = text.match(/\/del\s+(.+)/);
  if (!match) {
    ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
    return sendMessageDelete({
      BOT_TOKEN,
      chatId,
      payload: { text: "❌ 格式错误！正确格式: /del 关键词" },
      ms: 6000,
      ctx,
    });
  }

  const keywordToDelete = match[1].trim();
  const ruleKey = `rules_${chatId}`;
  const rules = JSON.parse((await TELEGRAM_RULES.get(ruleKey)) || "[]");

  let found = false;

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const idx = (r.keywords || []).indexOf(keywordToDelete);
    if (idx !== -1) {
      r.keywords.splice(idx, 1);
      // 清理去重并按长度降序
      r.keywords = Array.from(new Set(r.keywords)).filter(Boolean).sort((a, b) => b.length - a.length);
      // 重新 signature
      r.signature = [...r.keywords].sort((a, b) => a.localeCompare(b)).join("||");
      if (r.keywords.length === 0) rules.splice(i, 1);
      found = true;
      break;
    }
  }

  if (!found) {
    ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
    return sendMessageDelete({
      BOT_TOKEN,
      chatId,
      payload: { text: `❌ 没有找到关键词: ${keywordToDelete}` },
      ms: 6000,
      ctx,
    });
  }

  await TELEGRAM_RULES.put(ruleKey, JSON.stringify(rules));

  ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
  return sendMessageDelete({
    BOT_TOKEN,
    chatId,
    payload: { text: `✅ 已删除关键词: ${keywordToDelete}` },
    ms: 4000,
    ctx,
  });
}

async function handleListCommand({ chatId, messageId, TELEGRAM_RULES, BOT_TOKEN, ctx }) {
  const ruleKey = `rules_${chatId}`;
  const rules = JSON.parse((await TELEGRAM_RULES.get(ruleKey)) || "[]");

  if (rules.length === 0) {
    ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
    return sendMessageDelete({
      BOT_TOKEN,
      chatId,
      payload: { text: "❌ 当前群组没有设置规则。" },
      ms: 5000,
      ctx,
    });
  }

  let out = "📋 当前群组规则：\n";
  rules.forEach((r, i) => {
    out += `\n🔹 规则${i + 1}\n`;
    (r.keywords || []).forEach(k => (out += `  关键词: ${k}\n`));
    // list 里展示纯文本（不展开 entities）
    if (r.reply?.text) out += `  回复: ${r.reply.text}\n`;
  });

  ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
  return sendMessageDelete({
    BOT_TOKEN,
    chatId,
    payload: { text: out },
    ms: 15000,
    ctx,
  });
}

async function handleGlobalListCommand({ chatId, messageId, TELEGRAM_RULES, BOT_TOKEN, isPrivateChat, ctx }) {
  if (!isPrivateChat) {
    return sendMessageDelete({
      BOT_TOKEN,
      chatId,
      payload: { text: "❌ 你没有权限执行此命令。" },
      ms: 6000,
      ctx,
    });
  }

  const list = await TELEGRAM_RULES.list();
  let out = "📋 所有群组规则：\n";

  for (const key of list.keys) {
    if (!key.name.startsWith("rules_")) continue;

    const groupId = key.name.split("_")[1];
    const rules = JSON.parse((await TELEGRAM_RULES.get(key.name)) || "[]");
    if (!rules.length) continue;

    out += `\n群组 ID: ${groupId}\n`;
    rules.forEach((r, i) => {
      out += `规则${i + 1}:\n`;
      (r.keywords || []).forEach(k => (out += ` 关键词: ${k}\n`));
      if (r.reply?.text) out += ` 回复: ${r.reply.text}\n`;
    });
  }

  ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
  return sendMessageDelete({
    BOT_TOKEN,
    chatId,
    payload: { text: out },
    ms: 20000,
    ctx,
  });
}

async function handleAdminCommand({ chatId, messageId, isPrivateChat, BOT_TOKEN, ctx }) {
  if (isPrivateChat) {
    return sendMessage({
      BOT_TOKEN,
      chatId,
      payload: { text: "请将bot添加到你的群组后使用。" },
    });
  }

  const admins = await getGroupAdmins({ chatId, BOT_TOKEN });
  let out = "👑 当前群组管理员：\n";
  if (!admins.length) out += "（无）\n";
  else admins.forEach(id => (out += `🔹 管理员 ID: ${id}\n`));

  ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
  return sendMessageDelete({
    BOT_TOKEN,
    chatId,
    payload: { text: out },
    ms: 10000,
    ctx,
  });
}

async function handleStartCommand({ chatId, messageId, isPrivateChat, BOT_TOKEN, ctx }) {
  const out =
    "👋 欢迎使用 Telegram 自动回复机器人！\n\n" +
    "常用命令：\n" +
    "/add 关键词1||关键词2===回复内容  - 添加规则（回复只支持一条，支持格式）\n" +
    "/del 关键词 - 删除关键词\n" +
    "/list - 查看本群规则\n" +
    "/help - 查看帮助\n";

  ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));

  if (isPrivateChat) {
    return sendMessage({ BOT_TOKEN, chatId, payload: { text: out } });
  }

  return sendMessageDelete({
    BOT_TOKEN,
    chatId,
    payload: { text: out },
    ms: 12000,
    ctx,
  });
}

async function handleHelpCommand({ chatId, messageId, isPrivateChat, BOT_TOKEN, ctx }) {
  const out =
    "💡 帮助：\n\n" +
    "✅ 添加规则（回复只支持一条）：\n" +
    "/add install===`install all`\n" +
    "/add hello||hi===你好！\n\n" +
    "✅ 删除关键词：\n" +
    "/del install\n\n" +
    "✅ 查看规则：\n" +
    "/list\n\n" +
    "说明：\n" +
    "- 只有管理员可管理规则\n" +
    "- 机器人会保留你输入的格式（代码/粗体/链接等）\n";

  ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));

  if (isPrivateChat) {
    return sendMessage({ BOT_TOKEN, chatId, payload: { text: out } });
  }

  return sendMessageDelete({
    BOT_TOKEN,
    chatId,
    payload: { text: out },
    ms: 15000,
    ctx,
  });
}

async function handleAutoReplyAndDelete({ msg, chatId, messageId, userId, TELEGRAM_RULES, BOT_TOKEN, ctx }) {
  // 冷却：按 chat + user
  const onCooldown = await checkUserCooldown({ TELEGRAM_RULES, chatId, userId });
  if (onCooldown) {
    ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));
    return sendMessageDelete({
      BOT_TOKEN,
      chatId,
      payload: { text: "❌ 请不要频繁触发自动回复。" },
      ms: 5000,
      ctx,
    });
  }

  const ruleKey = `rules_${chatId}`;
  const rules = JSON.parse((await TELEGRAM_RULES.get(ruleKey)) || "[]");
  const incoming = (msg.text || "").toLowerCase();

  for (const r of rules) {
    const keywords = r.keywords || [];
    const hit = keywords.find(k => incoming.includes(String(k).toLowerCase()) || incoming === String(k).toLowerCase());

    if (hit) {
      // 删触发消息（后台）
      ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms: 3000 }));

      // ✅ 用 entities 原样回复
      const replyObj = r.reply && isRuleReplyObject(r.reply)
        ? r.reply
        : { text: String(r.reply?.text || ""), entities: [] };

      return sendMessageDelete({
        BOT_TOKEN,
        chatId,
        payload: {
          text: replyObj.text,
          entities: replyObj.entities,
        },
        ms: 20000,
        ctx,
      });
    }
  }

  return new Response("No matching rules.");
}

// --------------------- cooldown ---------------------

async function checkUserCooldown({ TELEGRAM_RULES, chatId, userId }) {
  const key = `cooldown_${chatId}_${userId}`;
  const last = await TELEGRAM_RULES.get(key);

  if (last) {
    const diff = Date.now() - Number(last);
    if (diff < 5000) return true;
  }

  await TELEGRAM_RULES.put(key, String(Date.now()));
  return false;
}

// --------------------- Telegram send/delete ---------------------

function sendMessage({ BOT_TOKEN, chatId, payload }) {
  // payload: { text, entities?, parse_mode? ... } —— 这里我们主要用 entities
  return fetch(`${TELEGRAM_API}${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, ...payload }),
  });
}

/**
 * 发消息 + 延时删除
 * - 删除放 ctx.waitUntil，避免阻塞回复
 * - payload 支持 entities，用于保留格式
 */
async function sendMessageDelete({ BOT_TOKEN, chatId, payload, ms, ctx }) {
  const res = await sendMessage({ BOT_TOKEN, chatId, payload });
  const data = await res.json();

  if (!res.ok || !data.ok) {
    console.error("sendMessage failed:", data);
    return new Response("OK");
  }

  const botMsgId = data.result.message_id;
  if (ctx && ms != null) {
    ctx.waitUntil(deleteMessageSleep({ BOT_TOKEN, chatId, messageId: botMsgId, ms }));
  }
  return new Response("OK");
}

async function deleteMessageSleep({ BOT_TOKEN, chatId, messageId, ms }) {
  await sleep(ms);
  return deleteMessage({ BOT_TOKEN, chatId, messageId });
}

function deleteMessage({ BOT_TOKEN, chatId, messageId }) {
  return fetch(`${TELEGRAM_API}${BOT_TOKEN}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
}
