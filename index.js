require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabase-store');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const dns = require('dns');
const https = require('https');
const bot = require('./bot');

function findChrome() {
    const paths = [
        path.join(__dirname, 'chrome', 'linux-146.0.7680.31', 'chrome-linux64', 'chrome'),
        '/opt/render/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
        '/usr/bin/chromium-browser', '/usr/bin/chromium',
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
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

let frozenQr = null;
let frozenQrTime = 0;
let clientReady = false;
let everConnected = false;
let client = null;

const store = new SupabaseStore();
const SESSION_KEY = 'consultor-bot';
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');

function makeClient() {
    const opts = {
        authStrategy: new LocalAuth({
            clientId: SESSION_KEY,
            dataPath: AUTH_DIR,
        }),
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

async function startBot() {
    const exists = await store.sessionExists(SESSION_KEY);
    if (exists) {
        console.log('Restaurando sesión...');
        await store.restoreSession(SESSION_KEY, AUTH_DIR);
    } else {
        console.log('No hay sesión. Se necesitará QR.');
    }

    client = makeClient();

    client.on('qr', (qr) => {
        const now = Date.now();
        // Freeze first QR for 3 minutes
        if (frozenQr && (now - frozenQrTime < 180000)) return;
        frozenQr = qr;
        frozenQrTime = now;
        if (everConnected) return;
        console.log('=== QR (válido 3 min) ===');
        qrcodeTerminal.generate(qr, { small: true });
    });

    client.on('ready', async () => {
        clientReady = true;
        everConnected = true;
        console.log('WhatsApp conectado correctamente');
        // Intentar backup cada minuto hasta que funcione
        for (let i = 0; i < 5; i++) {
            const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
            if (fs.existsSync(sessionDir)) {
                await store.saveSession(SESSION_KEY, sessionDir);
                // Verificar que se guardó
                const ok = await store.sessionExists(SESSION_KEY);
                if (ok) {
                    console.log('Sesión respaldada y verificada');
                    break;
                }
            }
            console.log('Backup falló, reintento en 60s...');
            await new Promise(r => setTimeout(r, 60000));
        }
    });

    client.on('disconnected', async (reason) => {
        clientReady = false;
        console.log('Desconectado:', reason);
        console.log('Reconectando en 10s...');
        await new Promise(r => setTimeout(r, 10000));
        try {
            await client.initialize();
        } catch (e) {
            console.log('Error reconectando:', e.message);
        }
    });

    client.on('message', (msg) => {
        if (msg.from === 'status@broadcast') return;
        if (msg.from.endsWith('@g.us')) return;
        if (msg.author && msg.author !== msg.from) return;
        if (msg.fromMe) return;
        console.log('Msg de', msg.from, 'tipo:', msg.type);
        bot.handleMessage(client, msg);
    });

    client.initialize();
}

app.get('/', (req, res) => {
    res.json({ status: clientReady ? 'conectado' : 'conectando', qr: !!frozenQr });
});

app.get('/qr', async (req, res) => {
    if (!frozenQr) {
        return res.send('<h3>Generando QR. Espera 10s y recarga.</h3>');
    }
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
<p style="font-size:12px;color:#555">Este QR es válido por 3 minutos</p>
</div></body></html>`);
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.get('/diag', (req, res) => {
    const results = { node: process.version, platform: process.platform };
    const tasks = [
        new Promise(r => dns.resolve('web.whatsapp.com', (e, a) => { results.dns = e ? e.message : a[0]; r(); })),
        new Promise(r => dns.resolve('graph.facebook.com', (e, a) => { results.fb_dns = e ? e.message : a[0]; r(); })),
        new Promise(r => dns.resolve('api.groq.com', (e, a) => { results.groq_dns = e ? e.message : a[0]; r(); })),
        new Promise(r => https.get('https://web.whatsapp.com', { timeout: 10000 }, (resp) => { results.whatsapp_http = resp.statusCode; r(); }).on('error', e => { results.whatsapp_http = e.message; r(); })),
        new Promise(r => https.get('https://api.groq.com', { timeout: 10000 }, (resp) => { results.groq_http = resp.statusCode; r(); }).on('error', e => { results.groq_http = e.message; r(); })),
    ];
    Promise.all(tasks).then(() => res.json(results));
});

app.listen(PORT, () => {
    console.log('Servidor en puerto', PORT);
    startBot();
});
