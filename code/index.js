const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

// --- CONFIGURATION ---
// Get these from Vercel Environment Variables
const token = process.env.TELEGRAM_BOT_TOKEN; 
const admin = process.env.ADMIN_ID; 
const DATABASE_URL = process.env.FIREBASE_DB_URL; // e.g., https://project.firebaseio.com
const WEBHOOK_URL = process.env.VERCEL_URL; // e.g., https://your-app.vercel.app
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL; // e.g., @YourChannel

const API_BASE = 'https://arsychat-api.metaspace.workers.dev/api';
const MODELS = {
  'GLM': 'glm',
  'DeepSeek': 'deepseek',
  'Qwen': 'qwen',
  'Kimi': 'kimi'
};

const bot = new TelegramBot(token, { webHook: { port: false } });
const app = express();
app.use(express.json());

// Set Webhook automatically on first run
bot.setWebHook(WEBHOOK_URL);

const broadcastSessions = {};

// --- HELPER FUNCTIONS ---

async function saveUserToFirebase(user) {
  const url = `${DATABASE_URL}/users/${user.id}.json`;
  // We use PATCH to update user info without deleting their selected model
  const payload = {
    id: user.id,
    first_name: user.first_name || "",
    username: user.username || "",
    timestamp: Date.now()
  };
  await fetch(url, {
    method: "PATCH",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  });
}

async function getUserFromFirebase(userId) {
  const url = `${DATABASE_URL}/users/${userId}.json`;
  const res = await fetch(url);
  return await res.json();
}

async function updateUserModel(userId, model) {
  const url = `${DATABASE_URL}/users/${userId}.json`;
  await fetch(url, {
    method: "PATCH",
    body: JSON.stringify({ current_model: model }),
    headers: { "Content-Type": "application/json" }
  });
}

async function getTotalUsers() {
  const url = `${DATABASE_URL}/users.json?shallow=true`; // shallow=true is faster
  const res = await fetch(url);
  const data = await res.json();
  return data ? Object.keys(data).length : 0;
}

async function checkMembership(userId) {
  if (!REQUIRED_CHANNEL) return true; // Skip if no channel set
  try {
    const chatMember = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    return ['creator', 'administrator', 'member'].includes(chatMember.status);
  } catch {
    return false;
  }
}

// --- MAIN ROUTE ---

app.post("/", async (req, res) => {
  const update = req.body;
  
  // 1. Handle Callback Queries (Buttons)
  if (update.callback_query) {
    const query = update.callback_query;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (MODELS[data]) {
      // Check Membership before setting model
      if (await checkMembership(userId)) {
        await updateUserModel(userId, data);
        await bot.answerCallbackQuery(query.id, { text: `✅ Model set to ${data}` });
        await bot.sendMessage(chatId, `🧠 *Model Switched to ${data}*\n\nSend me a message to start chatting!`, { parse_mode: "Markdown" });
      } else {
        await bot.answerCallbackQuery(query.id, { text: "❌ Join channel first!", show_alert: true });
      }
    }
    return res.end("OK");
  }

  // 2. Handle Messages
  const msg = update.message;
  if (!msg || !msg.text) return res.end("OK");

  const chatId = msg.chat.id;
  const user = msg.from;
  const userIdString = user.id.toString();

  // --- COMMAND: /start ---
  if (msg.text === "/start") {
    const exists = await getUserFromFirebase(user.id);
    
    // Check Membership
    const isMember = await checkMembership(user.id);
    if (!isMember) {
        const keyboard = {
            inline_keyboard: [[{ text: "📢 Join Channel", url: `https://t.me/${REQUIRED_CHANNEL.replace('@','')}` }]]
        };
        await bot.sendMessage(chatId, `👋 *Hello ${user.first_name}*\n\nPlease join our channel to use this bot.`, { parse_mode: "Markdown", reply_markup: keyboard });
        return res.end("OK");
    }

    const text = `*👋 Welcome* [${user.first_name}](tg://user?id=${user.id})\n\n*🧠 Choose an AI Model below to start chatting:*`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '🤖 GLM-4', callback_data: 'GLM' }, { text: '🧠 DeepSeek', callback_data: 'DeepSeek' }],
            [{ text: '👁️ Qwen', callback_data: 'Qwen' }, { text: '🌙 Kimi', callback_data: 'Kimi' }]
        ]
    };

    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: keyboard
    });

    if (!exists) {
      await saveUserToFirebase(user);
      const totalUsers = await getTotalUsers();
      const newUserMsg =
        "➕ <b>New User Notification</b> ➕\n\n" +
        "👤<b>User:</b> <a href='tg://user?id=" + user.id + "'>" + user.first_name + "</a>\n" +
        "🆔<b>ID:</b> <code>" + user.id + "</code>\n" +
        "🌝 <b>Total Users: " + totalUsers + "</b>";
      
      // Send only if admin ID is set
      if(admin) await bot.sendMessage(admin, newUserMsg, { parse_mode: "HTML" });
    }
  }

  // --- COMMAND: /broadcast ---
  else if (msg.text === "/broadcast" && userIdString === admin) {
    await bot.sendMessage(chatId, "<b>Enter Broadcast Message Here 👇</b>", {
      parse_mode: "HTML"
    });
    broadcastSessions[chatId] = true;
  } 
  
  // --- BROADCAST LOGIC ---
  else if (broadcastSessions[chatId] && userIdString === admin) {
    delete broadcastSessions[chatId];
    const usersUrl = `${DATABASE_URL}/users.json`;
    const resUsers = await fetch(usersUrl);
    const data = await resUsers.json();
    
    if (data) {
      await bot.sendMessage(chatId, "🚀 Broadcast started...");
      const userIds = Object.keys(data);
      let successCount = 0;
      let failCount = 0;

      // Broadcast loop
      for (const id of userIds) {
        try {
          await bot.copyMessage(id, chatId, msg.message_id);
          successCount++;
          // Small delay to prevent hitting rate limits
          await new Promise(r => setTimeout(r, 50)); 
        } catch (e) {
          failCount++;
        }
      }
      await bot.sendMessage(chatId, `✅ Broadcast completed.\n\n📤 Sent: ${successCount}\n❌ Failed: ${failCount}`);
    } else {
      await bot.sendMessage(chatId, "❌ No users found.");
    }
  } 
  
  // --- COMMAND: /model ---
  else if (msg.text === "/model") {
      const keyboard = {
        inline_keyboard: [
            [{ text: '🤖 GLM-4', callback_data: 'GLM' }, { text: '🧠 DeepSeek', callback_data: 'DeepSeek' }],
            [{ text: '👁️ Qwen', callback_data: 'Qwen' }, { text: '🌙 Kimi', callback_data: 'Kimi' }]
        ]
      };
      await bot.sendMessage(chatId, "🔄 *Switch AI Model:*", { parse_mode: "Markdown", reply_markup: keyboard });
  }

  // --- AI CHAT LOGIC ---
  else if (msg.text && !msg.text.startsWith('/')) {
    
    // 1. Check Membership
    if (!(await checkMembership(user.id))) {
        return bot.sendMessage(chatId, "⚠️ Please join our channel first.", { 
            reply_markup: { inline_keyboard: [[{ text: "Join Channel", url: `https://t.me/${REQUIRED_CHANNEL.replace('@','')}` }]] } 
        });
    }

    // 2. Get User & Model
    const userData = await getUserFromFirebase(user.id);
    
    if (!userData || !userData.current_model) {
        return bot.sendMessage(chatId, "⚠️ Please select a model first using /model or /start");
    }

    // 3. Call ArsyChat API
    await bot.sendChatAction(chatId, "typing");
    
    const modelSlug = MODELS[userData.current_model];
    // Encode the prompt
    const apiUrl = `${API_BASE}/${modelSlug}/v1/chat/completions?prompt=${encodeURIComponent(msg.text)}`;

    try {
      const response = await fetch(apiUrl, { method: 'GET' });
      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || "❌ No response from AI.";
      
      const keyboard = {
        inline_keyboard: [
            [{ text: "🔄 Change Model", callback_data: "switch_model_dummy" }] // Dummy button for looks or functionality
        ]
      };

      // Try sending markdown, fallback to plain text if syntax error
      try {
          await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      } catch {
          await bot.sendMessage(chatId, reply);
      }
      
    } catch (e) {
      await bot.sendMessage(chatId, "❌ API Error. Please try again later.");
    }
  }

  res.end("OK");
});

app.get("/", (req, res) => {
  res.send("Bot is Active!");
});

module.exports = app;
