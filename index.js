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
if (chromePath) console.log('Chrome encontrado en:', chromePath);
else console.log('Chrome NO encontrado, whatsapp-web.js puede fallar');

const app = express();
const PORT = process.env.PORT || 8080;

let qrData = null;
let qrDataTime = 0;
let clientReady = false;
let everConnected = false;

const store = new SupabaseStore();
const SESSION_KEY = 'consultor-bot.zip';
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');

async function ensureSession() {
    const exists = await store.sessionExists(SESSION_KEY);
    if (exists) {
        console.log('Restaurando sesión desde Supabase...');
        await store.restoreSession(SESSION_KEY, AUTH_DIR);
    } else {
        console.log('No hay sesión guardada. Se requerirá QR.');
    }
}

async function backupSession() {
    const sessionDir = path.join(AUTH_DIR, 'session-consultor-bot');
    if (!fs.existsSync(sessionDir)) {
        console.log('Directorio de sesión no encontrado');
        return;
    }
    await store.saveSession(SESSION_KEY, sessionDir);
}

async function startApp() {
    await ensureSession();

    const clientOpts = {
        authStrategy: new LocalAuth({
            clientId: 'consultor-bot',
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
    if (chromePath) clientOpts.puppeteer.executablePath = chromePath;
    const client = new Client(clientOpts);

    client.on('qr', (qr) => {
        qrData = qr;
        qrDataTime = Date.now();
        if (everConnected) return;
        console.log('=== NUEVO QR GENERADO ===');
        qrcodeTerminal.generate(qr, { small: true });
    });

    client.on('ready', async () => {
        clientReady = true;
        everConnected = true;
        console.log('WhatsApp conectado correctamente');
        await backupSession();
        setInterval(() => backupSession(), 300000);
    });

    client.on('disconnected', (reason) => {
        clientReady = false;
        console.log('WhatsApp desconectado:', reason);
    });

    function handleIncoming(msg) {
        if (msg.from === 'status@broadcast') return;
        if (msg.from.endsWith('@g.us')) return;
        if (msg.author && msg.author !== msg.from) return;
        if (msg.fromMe) return;
        console.log('Mensaje recibido de', msg.from, 'tipo:', msg.type, 'texto:', (msg.body || '').slice(0, 60));
        bot.handleMessage(client, msg);
    }

    client.on('message', handleIncoming);

    app.get('/', (req, res) => {
        res.json({ status: clientReady ? 'conectado' : 'conectando', qr: !!qrData });
    });

    app.get('/qr', async (req, res) => {
        if (!qrData) {
            return res.send('<h3>QR no disponible. Revisa los logs de Render.</h3>');
        }
        if (Date.now() - qrDataTime > 180000) {
            return res.send('<h3>QR expirado. Espera nuevo QR en logs.</h3>');
        }
        const img = await qrcode.toDataURL(qrData);
        res.type('html');
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>QR Consultor Bot</title><style>body{background:#111;display:flex;justify-content:center;align-items:center;min-height:95vh;margin:0}img{width:280px;height:280px;border:5px solid #333;border-radius:12px;background:white;padding:10px}</style></head><body><div><p style="color:#4caf50;text-align:center;font-family:sans-serif;font-size:16px;margin-bottom:10px">${everConnected ? '\u2713 Conectado (QR innecesario)' : 'Escanea para conectar'}</p><img src="${img}" alt="QR"/><p style="color:#888;text-align:center;font-family:sans-serif;font-size:13px">Abre WhatsApp \u2192 Ajustes \u2192 Dispositivos vinculados \u2192 Vincular dispositivo</p></div></body></html>`);
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

    client.initialize();
}

app.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
    startApp().catch(e => console.error('startApp error:', e));
});
