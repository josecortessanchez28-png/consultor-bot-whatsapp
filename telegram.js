const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const database = require('./database');
const bot = require('./bot');

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ESTHER_ID = process.env.ESTHER_TELEGRAM_ID;
const app = express();

let heartbeatInterval;
let telegramBot;

async function waitForActiveInstance() {
    console.log('[index] Comprobando si otra instancia está activa...');
    while (true) {
        const active = await database.getActiveInstance();
        if (!active) {
            console.log('[index] No hay otra instancia activa. Tomando control.');
            break;
        }
        const age = Date.now() - active.timestamp;
        if (age > 15000) {
            console.log(`[index] La otra instancia parece haber muerto (inactiva por ${(age / 1000).toFixed(1)}s). Tomando control.`);
            break;
        }
        if (active.instanceId === database.INSTANCE_ID) break;
        console.log(`[index] Otra instancia (${active.instanceId}) está activa. Esperando...`);
        await new Promise(r => setTimeout(r, 2000));
    }
    heartbeatInterval = setInterval(async () => {
        await database.updateHeartbeat();
    }, 5000);
    await database.updateHeartbeat();
}

function startKeepAlive() {
    const url = process.env.RENDER_EXTERNAL_URL || 'https://consultor-bot-whatsapp.onrender.com';
    console.log('KeepAlive cada 4 min');
    const ping = () => https.get(url + '/healthz', () => {}).on('error', () => {});
    ping(); setTimeout(ping, 120000); setInterval(ping, 240000);
}

process.on('SIGTERM', async () => {
    console.log('SIGTERM - deteniendo bot...');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    if (telegramBot) {
        try { await telegramBot.stopPolling(); } catch (_) {}
    }
    await database.releaseHeartbeat();
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    console.log('[unhandledRejection]', err?.stack || err?.message || err);
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, async () => {
    console.log('Servidor en puerto', PORT);
    await waitForActiveInstance();
    telegramBot = new TelegramBot(TOKEN, { polling: true });
    telegramBot.on('message', (msg) => {
        const senderId = String(msg.from?.id || '');
        if (senderId !== ESTHER_ID) {
            console.log('Ignorando usuario no autorizado:', senderId);
            return;
        }
        bot.handleMessage(telegramBot, msg);
    });
    console.log('Bot de Telegram iniciado');
    startKeepAlive();
});
