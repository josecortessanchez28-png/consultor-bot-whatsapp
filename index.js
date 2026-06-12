require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const pino = require('pino');
const bot = require('./bot');

const app = express();
const PORT = process.env.PORT || 8080;

let qrData = null;
let qrDataTime = 0;
let clientReady = false;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['ConsultorBot', 'Chrome', '1.0'],
        logger: pino({ level: 'silent' }),
        qrTimeout: 120,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrData = qr;
            qrDataTime = Date.now();
            console.log('=== NUEVO QR GENERADO ===');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('Escanea el QR desde el móvil secundario');
            console.log('También en /qr');
        }

        if (connection === 'open') {
            clientReady = true;
            console.log('WhatsApp conectado correctamente');
        }

        if (connection === 'close') {
            clientReady = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('WhatsApp desconectado. Reconectar:', shouldReconnect);
            if (shouldReconnect) setTimeout(startBot, 3000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg || msg.key.fromMe) return;
        if (msg.key.remoteJid.endsWith('@g.us')) return;

        const jid = msg.key.remoteJid;
        let text = '';

        if (msg.message?.conversation) {
            text = msg.message.conversation.trim();
        } else if (msg.message?.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text.trim();
        } else if (msg.message?.audioMessage) {
            await sock.sendMessage(jid, { text: 'Transcribiendo audio...' });
            try {
                const stream = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }
                text = await bot.transcribeAudio(buffer);
                if (!text) {
                    await sock.sendMessage(jid, { text: 'No entendí el audio.' });
                    return;
                }
            } catch (e) {
                console.error('audio error:', e);
                await sock.sendMessage(jid, { text: 'Error al procesar el audio.' });
                return;
            }
        }

        if (!text) return;

        const resp = await bot.handleMessage(jid, text);
        await sock.sendMessage(jid, { text: resp || 'No pude generar respuesta.' });
    });

    return sock;
}

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

startBot();
