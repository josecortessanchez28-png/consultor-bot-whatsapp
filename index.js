require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
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

let frozenQr = null;
let frozenQrTime = 0;
let clientReady = false;
let everConnected = false;
let currentClient = null;

function makeClient() {
    const opts = {
        authStrategy: new LocalAuth({ clientId: 'consultor-bot', dataPath: AUTH_DIR }),
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
        const now = Date.now();
        if (frozenQr && (now - frozenQrTime < 180000)) return;
        frozenQr = qr;
        frozenQrTime = now;
        if (everConnected) return;
        console.log('=== QR (válido 3 min) ===');
        qrcodeTerminal.generate(qr, { small: true });
    });

    client.on('ready', () => {
        clientReady = true;
        everConnected = true;
        console.log('WhatsApp conectado correctamente');
    });

    client.on('disconnected', async () => {
        clientReady = false;
        console.log('Desconectado. Creando nuevo cliente en 10s...');
        await new Promise(r => setTimeout(r, 10000));
        startClient();
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

function startClient() {
    if (currentClient) {
        try { currentClient.destroy(); } catch (_) {}
    }
    currentClient = makeClient();
    setupClient(currentClient);
}

// Self-keepalive to prevent Render free tier spin-down
function startKeepAlive() {
    const publicUrl = process.env.RENDER_EXTERNAL_URL || `https://consultor-bot-whatsapp.onrender.com`;
    console.log('KeepAlive a', publicUrl, 'cada 5 min');
    setInterval(() => {
        https.get(`${publicUrl}/healthz`, () => {}).on('error', () => {});
    }, 300000);
}

app.get('/', (req, res) => {
    res.json({ status: clientReady ? 'conectado' : 'conectando', qr: !!frozenQr });
});

app.get('/qr', async (req, res) => {
    if (!frozenQr) return res.send('<h3>Generando QR. Recarga en 10s.</h3>');
    const img = await qrcode.toDataURL(frozenQr);
    res.type('html');
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30">
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
<p class="${clientReady ? 'green' : 'red'}">${clientReady ? '\u2713 Conectado' : 'Escanea para conectar'}</p>
<img src="${img}" alt="QR"/>
<p>Abre WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo</p>
<p style="font-size:12px;color:#555">QR válido 3 min</p>
</div></body></html>`);
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
    console.log('Servidor en puerto', PORT);
    startClient();
    startKeepAlive();
});
