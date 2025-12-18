const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

// --- ENVIRONMENT VARIABLES ---
const token = process.env.TELEGRAM_BOT_TOKEN; 
const DATABASE_URL = process.env.FIREBASE_DB_URL; 
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL; 
const ADMIN_ID = process.env.ADMIN_ID; 
const WEBHOOK_URL = process.env.WEBHOOK_URL; // <-- Added this
const API_BASE = 'https://arsychat-api.metaspace.workers.dev/api';

const MODELS = {
  'GLM': 'glm',
  'DeepSeek': 'deepseek',
  'Qwen': 'qwen',
  'Kimi': 'kimi'
};

// INITIALIZE BOT
const bot = new TelegramBot(token, { polling: false });
const app = express();
app.use(express.json());

// --- AUTO SET WEBHOOK ---
// Agar Environment Variable mein URL hai, to webhook set karo
if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL).then(() => {
        console.log(`Webhook set to: ${WEBHOOK_URL}`);
    }).catch(err => {
        console.error("Webhook Error:", err.message);
    });
}

// Broadcast State
const broadcastSessions = {};

// --- KEYBOARDS ---

const getJoinKeyboard = () => ({
    inline_keyboard: [
        [{ text: "📢 Join Official Channel", url: `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}` }],
        [{ text: "✅ Verify / I have Joined", callback_data: "check_join" }]
    ]
});

const getModelKeyboard = () => ({
    inline_keyboard: [
        [{ text: '🤖 GLM-4', callback_data: 'GLM' }, { text: '🧠 DeepSeek', callback_data: 'DeepSeek' }],
        [{ text: '👁️ Qwen', callback_data: 'Qwen' }, { text: '🌙 Kimi', callback_data: 'Kimi' }]
    ]
});

const getBackKeyboard = () => ({
    inline_keyboard: [
        [{ text: "🔄 Change Model", callback_data: "back_to_models" }]
    ]
});

// --- DATABASE FUNCTIONS ---

async function saveUser(userId, name) {
    if (!DATABASE_URL) return false;
    try {
        const check = await fetch(`${DATABASE_URL}/users/${userId}.json`);
        const exists = await check.json();
        
        await fetch(`${DATABASE_URL}/users/${userId}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ id: userId, first_name: name, last_seen: Date.now() }),
            headers: { 'Content-Type': 'application/json' }
        });
        return !exists;
    } catch (e) { return false; }
}

async function getUser(userId) {
    if (!DATABASE_URL) return {};
    try {
        const res = await fetch(`${DATABASE_URL}/users/${userId}.json`);
        return await res.json();
    } catch (e) { return {}; }
}

async function setModel(userId, model) {
    if (!DATABASE_URL) return;
    try {
        await fetch(`${DATABASE_URL}/users/${userId}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ current_model: model }),
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) { console.error(e); }
}

async function getAllUsers() {
    if (!DATABASE_URL) return [];
    try {
        const res = await fetch(`${DATABASE_URL}/users.json`);
        const data = await res.json();
        return data ? Object.keys(data) : [];
    } catch (e) { return []; }
}

async function checkMembership(userId) {
    if (!REQUIRED_CHANNEL) return true;
    try {
        const chatMember = await bot.getChatMember(REQUIRED_CHANNEL, userId);
        return ['creator', 'administrator', 'member'].includes(chatMember.status);
    } catch (e) { return false; }
}

// --- MAIN HANDLER ---

app.post("/", async (req, res) => {
    try {
        const update = req.body;
        bot.processUpdate(update);

        // --- BUTTONS ---
        if (update.callback_query) {
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const userId = query.from.id;
            const data = query.data;
            const msgId = query.message.message_id;

            if (data === "check_join") {
                const isMember = await checkMembership(userId);
                if (isMember) {
                    try { await bot.deleteMessage(chatId, msgId); } catch(e){}
                    await bot.answerCallbackQuery(query.id, { text: "✅ Verified!" });
                    await bot.sendMessage(chatId, "🎉 *Verification Successful!*\n\n🧠 *Select an AI Model:*", { 
                        parse_mode: "Markdown", 
                        reply_markup: getModelKeyboard() 
                    });
                } else {
                    await bot.answerCallbackQuery(query.id, { text: "❌ Not Joined Yet!", show_alert: true });
                }
            }
            else if (MODELS[data]) {
                const isMember = await checkMembership(userId);
                if (isMember) {
                    await setModel(userId, data);
                    try {
                        await bot.editMessageText(`✅ *Model set to: ${data}*\n\n👇 You can now chat!`, {
                            chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: getBackKeyboard()
                        });
                    } catch (e) {
                        await bot.sendMessage(chatId, `✅ *Model set to: ${data}*\n\n👇 Start chatting!`, {
                            parse_mode: "Markdown", reply_markup: getBackKeyboard()
                        });
                    }
                    await bot.answerCallbackQuery(query.id, { text: `Selected: ${data}` });
                } else {
                    await bot.answerCallbackQuery(query.id, { text: "⚠️ Join Channel First!", show_alert: true });
                }
            }
            else if (data === "back_to_models") {
                try {
                    await bot.editMessageText("🧠 *Choose an AI Model:*", {
                        chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: getModelKeyboard()
                    });
                } catch (e) {
                    await bot.sendMessage(chatId, "🧠 *Choose an AI Model:*", {
                        parse_mode: "Markdown", reply_markup: getModelKeyboard()
                    });
                }
                await bot.answerCallbackQuery(query.id);
            }
        }

        // --- MESSAGES ---
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const text = msg.text;
            const userId = msg.from.id;

            if (!text) return res.send("OK");

            // /start
            if (text === "/start") {
                const isNewUser = await saveUser(userId, msg.from.first_name);
                if (isNewUser && ADMIN_ID) {
                    const totalUsers = (await getAllUsers()).length;
                    await bot.sendMessage(ADMIN_ID, `➕ <b>New User</b>\n👤 ${msg.from.first_name}\n🆔 <code>${userId}</code>\n📊 Total: ${totalUsers}`, { parse_mode: "HTML" }).catch(()=>{});
                }

                const isMember = await checkMembership(userId);
                if (!isMember) {
                    await bot.sendMessage(chatId, `👋 *Hello ${msg.from.first_name}*\n\n🔒 To use this bot, you must join our channel first.`, {
                        parse_mode: "Markdown", reply_markup: getJoinKeyboard()
                    });
                } else {
                    await bot.sendMessage(chatId, `👋 *Welcome Back!*\n\n🧠 Choose an AI Model:`, {
                        parse_mode: "Markdown", reply_markup: getModelKeyboard()
                    });
                }
            }

            // /broadcast
            else if (text === "/broadcast" && userId.toString() === ADMIN_ID) {
                broadcastSessions[chatId] = true;
                await bot.sendMessage(chatId, "📣 <b>Broadcast Mode</b>\n\nSend message to broadcast.", { parse_mode: "HTML" });
            }

            // /model
            else if (text === "/model") {
                await bot.sendMessage(chatId, "🔄 *Switch Model:*", { parse_mode: "Markdown", reply_markup: getModelKeyboard() });
            }

            // Broadcast Logic
            else if (broadcastSessions[chatId] && userId.toString() === ADMIN_ID) {
                delete broadcastSessions[chatId];
                await bot.sendMessage(chatId, "🚀 Starting broadcast...");
                const users = await getAllUsers();
                let success = 0, fail = 0;
                for (const uid of users) {
                    try {
                        await bot.copyMessage(uid, chatId, msg.message_id);
                        success++;
                        await new Promise(r => setTimeout(r, 30)); 
                    } catch (e) { fail++; }
                }
                await bot.sendMessage(chatId, `✅ <b>Done</b>\nSent: ${success}\nFailed: ${fail}`, { parse_mode: "HTML" });
            }

            // AI Chat
            else if (!text.startsWith("/")) {
                const isMember = await checkMembership(userId);
                if (!isMember) {
                    return bot.sendMessage(chatId, "⚠️ *Access Denied*\nPlease verify subscription:", {
                        parse_mode: "Markdown", reply_markup: getJoinKeyboard()
                    });
                }

                const userData = await getUser(userId);
                const currentModel = userData?.current_model || 'glm'; 
                await bot.sendChatAction(chatId, "typing");
                const modelSlug = MODELS[currentModel] || 'glm';
                const apiUrl = `${API_BASE}/${modelSlug}/v1/chat/completions?prompt=${encodeURIComponent(text)}`;

                try {
                    const apiRes = await fetch(apiUrl);
                    const apiData = await apiRes.json();
                    const reply = apiData.choices?.[0]?.message?.content || "❌ AI Error.";
                    try { await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" }); } catch { await bot.sendMessage(chatId, reply); }
                } catch (err) {
                    await bot.sendMessage(chatId, "❌ Server Error.");
                }
            }
        }
    } catch (error) { console.error(error); }

    res.status(200).send("OK");
});

app.get("/", (req, res) => res.send("Bot Active"));

module.exports = app;
