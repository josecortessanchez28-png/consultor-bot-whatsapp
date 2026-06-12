require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabase-store');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const https = require('https');
const bot = require('./bot');

function findChrome() {
    const paths = [
        path.join(__dirname, 'chrome', 'linux-146.0.7680.31', 'chrome-linux64', 'chrome'),
        '/opt/render/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
        '/usr/bin/chromium-browser', '/usr/bin/chromium',
    ];
    for (const p of paths) if (fs.existsSync(p)) return p;
    const dir = path.join(__dirname, 'chrome');
    if (fs.existsSync(dir)) {
        try {
            for (const v of fs.readdirSync(dir)) {
                const exe = path.join(dir, v, 'chrome-linux64', 'chrome');
                if (fs.existsSync(exe)) return exe;
            }
        } catch (_) {}
    }
    return null;
}

const chromePath = findChrome();
if (chromePath) console.log('Chrome:', chromePath);

const app = express();
const PORT = process.env.PORT || 8080;
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
const SESSION_KEY = 'consultor-bot';

const store = new SupabaseStore();

let displayQr = null;
let clientReady = false;
let everConnected = false;
let currentClient = null;

function makeClient() {
    const opts = {
        authStrategy: new LocalAuth({ clientId: SESSION_KEY, dataPath: AUTH_DIR }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--no-zygote',
                '--single-process', '--disable-gpu',
            ],
        },
    };
    if (chromePath) opts.puppeteer.executablePath = chromePath;
    return new Client(opts);
}

function setupClient(client) {
    client.on('qr', (qr) => {
        displayQr = qr;
        if (everConnected) return;
        console.log('=== QR ===');
        qrcodeTerminal.generate(qr, { small: true });
    });

    client.on('ready', async () => {
        clientReady = true;
        everConnected = true;
        displayQr = null;
        console.log('WhatsApp conectado correctamente');
        const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
        await store.saveSession(SESSION_KEY, sessionDir);
    });

    client.on('disconnected', (reason) => {
        clientReady = false;
        console.log('Desconectado:', reason);
    });

    client.on('message', (msg) => {
        if (msg.from === 'status@broadcast') return;
        if (msg.from.endsWith('@g.us')) return;
        if (msg.author && msg.author !== msg.from) return;
        if (msg.fromMe) return;
        console.log('Msg de', msg.from, 'tipo:', msg.type || msg._data?.type);
        bot.handleMessage(client, msg);
    });

    client.initialize();
}

async function startClient() {
    const exists = await store.sessionExists(SESSION_KEY);
    if (exists) {
        console.log('[index] Restaurando sesión...');
        await store.restoreSession(SESSION_KEY, AUTH_DIR);
    } else {
        console.log('[index] No hay sesión guardada. Se requerirá QR único.');
    }

    if (currentClient) { try { currentClient.destroy(); } catch (_) {} }
    currentClient = makeClient();
    setupClient(currentClient);
}

function startKeepAlive() {
    const url = process.env.RENDER_EXTERNAL_URL || 'https://consultor-bot-whatsapp.onrender.com';
    console.log('KeepAlive cada 4 min');
    const ping = () => https.get(url + '/healthz', () => {}).on('error', () => {});
    ping(); setTimeout(ping, 120000); setInterval(ping, 240000);
}

app.get('/', (req, res) => {
    res.json({ status: clientReady ? 'conectado' : 'conectando', qr: !!displayQr });
});

app.get('/qr', async (req, res) => {
    if (!displayQr) {
        if (clientReady) return res.send('<h3>Conectado. Sin QR.</h3>');
        return res.send('<h3>Generando QR. Recarga en 10s.</h3>');
    }
    const img = await qrcode.toDataURL(displayQr);
    res.type('html');
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15">
<title>QR Consultor Bot</title>
<style>
body{background:#111;display:flex;justify-content:center;align-items:center;min-height:95vh;margin:0;font-family:sans-serif}
.wrap{text-align:center}
img{width:280px;height:280px;border:5px solid #333;border-radius:12px;background:white;padding:10px}
p{color:#888;font-size:13px;margin:8px 0}
.green{color:#4caf50;font-size:16px}
.red{color:#f44336;font-size:16px}
</style></head>
<body><div class="wrap">
<p class="red">Escanea para conectar</p>
<img src="${img}" alt="QR"/>
<p>Abre WhatsApp → Ajustes → Dispositivos vinculados</p>
</div></body></html>`);
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
    console.log('Servidor en puerto', PORT);
    startClient();
    startKeepAlive();
});
