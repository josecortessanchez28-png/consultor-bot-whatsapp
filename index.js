require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
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

const clientOpts = {
    authStrategy: new LocalAuth({ clientId: 'consultor-bot' }),
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
    console.log('=== NUEVO QR GENERADO ===');
    qrcodeTerminal.generate(qr, { small: true });
});

client.on('ready', () => {
    clientReady = true;
    console.log('WhatsApp conectado correctamente');
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
client.on('message_create', handleIncoming);

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
    res.send(`<img src="${img}" style="width:300px;height:300px;image-rendering:pixelated"/>`);
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

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));

client.initialize();
