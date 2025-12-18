// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = 'https://arsychat-api.metaspace.workers.dev/api';

const bot = new TelegramBot(TOKEN, { polling: true });

const sessions = new Map(); // userId -> { model }

const endpoints = {
  GLM: `${API_BASE}/glm/v1/chat/completions`,
  DeepSeek: `${API_BASE}/deepseek/v1/chat/completions`,
  Qwen: `${API_BASE}/qwen/v1/chat/completions`,
  Kimi: `${API_BASE}/kimi/v1/chat/completions`
};

const modelKeyboard = {
  inline_keyboard: [
    [{ text: 'GLM', callback_data: 'GLM' }],
    [{ text: 'DeepSeek', callback_data: 'DeepSeek' }],
    [{ text: 'Qwen', callback_data: 'Qwen' }],
    [{ text: 'Kimi', callback_data: 'Kimi' }]
  ]
};

bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '👋 Welcome to ArsyChat Ai\nYour personal AI assistant.\n\n🧠 Choose an AI model below to begin chatting.', {
    reply_markup: modelKeyboard
  });
});

bot.on('callback_query', async query => {
  const userId = query.from.id;
  const model = query.data;
  sessions.set(userId, { model });
  await bot.answerCallbackQuery(query.id, { text: `✅ Model set to: ${model}` });
});

bot.on('message', async msg => {
  if (msg.text?.startsWith('/')) return;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = sessions.get(userId);
  if (!session || !session.model) {
    bot.sendMessage(chatId, 'Please select a model first using /start.');
    return;
  }
  const endpoint = endpoints[session.model];
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: msg.text }] }),
      timeout: 10000
    });
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || 'No response';
    bot.sendMessage(chatId, reply);
  } catch {
    bot.sendMessage(chatId, '❌ Error contacting AI. Try again later.');
  }
});
