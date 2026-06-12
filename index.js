require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const bot = require('./bot');

const app = express();
const PORT = process.env.PORT || 8080;

let qrData = null;
let qrDataTime = 0;
let clientReady = false;

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'consultor-bot' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-zygote',
            '--single-process',
        ],
    },
});

client.on('qr', (qr) => {
    qrData = qr;
    qrDataTime = Date.now();
    console.log('=== NUEVO QR GENERADO ===');
    qrcodeTerminal.generate(qr, { small: true });
    console.log('Escanea el QR desde el móvil secundario');
    console.log('También disponible en /qr');
});

client.on('ready', () => {
    clientReady = true;
    console.log('WhatsApp conectado correctamente');
});

client.on('disconnected', (reason) => {
    clientReady = false;
    console.log('WhatsApp desconectado:', reason);
});

client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;
    if (msg.from.endsWith('@g.us')) return;
    if (msg.author && msg.author !== msg.from) return;
    console.log('Mensaje de:', msg.from, msg.body?.slice(0, 50));
    await bot.handleMessage(client, msg);
});

app.get('/', (req, res) => {
    res.json({ status: clientReady ? 'conectado' : 'conectando', qr: !!qrData });
});

app.get('/qr', async (req, res) => {
    if (!qrData) {
        return res.send('<h3>QR no disponible aún. Revisa los logs de Render.</h3>');
    }
    if (Date.now() - qrDataTime > 180000) {
        return res.send('<h3>QR expirado. Espera a que se genere uno nuevo en los logs.</h3>');
    }
    const img = await qrcode.toDataURL(qrData);
    res.type('html');
    res.send(`<img src="${img}" style="width:300px;height:300px;image-rendering:pixelated"/>`);
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));

client.initialize();
