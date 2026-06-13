require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabase-store');

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
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 8080;
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
const SESSION_KEY = 'consultor-bot';

const store = new SupabaseStore();

let clientReady = false;
let everConnected = false;
let pairingInProgress = false;
let currentClient = null;
let pendingPairingCode = null;
let pendingPairingError = null;

async function startPairing(phone) {
    try {
        if (currentClient) {
            try { await currentClient.destroy(); } catch (_) {}
            currentClient = null;
        }
        clientReady = false;

        const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}

        console.log('[pair] Creando cliente con pairWithPhoneNumber para:', phone);
        currentClient = makeClient(phone);

        currentClient.on('code', (code) => {
            console.log('[pair] Código obtenido:', code);
            pendingPairingCode = code;
        });

        setupEvents(currentClient);
        await currentClient.initialize();
        console.log('[pair] initialize() completado');
    } catch (e) {
        console.log('[pair] Error en startPairing:', e.message);
        pendingPairingError = e.message;
    } finally {
        pairingInProgress = false;
    }
}

function makeClient(phoneNumber) {
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
    if (phoneNumber) {
        opts.pairWithPhoneNumber = { phoneNumber };
    }
    if (chromePath) opts.puppeteer.executablePath = chromePath;
    return new Client(opts);
}

function setupEvents(client) {
    client.on('ready', async () => {
        clientReady = true;
        everConnected = true;
        console.log('WhatsApp conectado correctamente');
        const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
        sessionSaveInProgress = true;
        try {
            console.log('[index] Guardando sesión inmediatamente...');
            await store.saveSession(SESSION_KEY, sessionDir);
            console.log('[index] Backup inicial completado');
        } catch (e) {
            console.log('[index] Error en backup inicial:', e.message);
        } finally {
            sessionSaveInProgress = false;
        }
        setInterval(() => store.saveSession(SESSION_KEY, sessionDir), 300000);
    });

    client.on('disconnected', (reason) => {
        clientReady = false;
        pairingInProgress = false;
        currentClient = null;
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
}

async function startClient() {
    const exists = await store.sessionExists(SESSION_KEY);
    if (exists) {
        console.log('[index] Restaurando sesión...');
        await store.restoreSession(SESSION_KEY, AUTH_DIR);
        if (currentClient) { try { currentClient.destroy(); } catch (_) {} }
        currentClient = makeClient();
        setupEvents(currentClient);
        currentClient.initialize();
    } else {
        console.log('[index] No hay sesión guardada. Ir a /pair para vincular.');
        // No crear cliente hasta que el usuario visite /pair
    }
}

function startKeepAlive() {
    const url = process.env.RENDER_EXTERNAL_URL || 'https://consultor-bot-whatsapp.onrender.com';
    console.log('KeepAlive cada 4 min');
    const ping = () => https.get(url + '/healthz', () => {}).on('error', () => {});
    ping(); setTimeout(ping, 120000); setInterval(ping, 240000);
}

app.get('/', (req, res) => {
    res.json({ status: clientReady ? 'conectado' : 'conectando' });
});

app.get('/pair', (req, res) => {
    if (clientReady) return res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Conectado</title><style>body{background:#111;color:#eee;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:95vh;margin:0;text-align:center}</style></head><body><h2>Conectado</h2><p>El bot ya está vinculado a WhatsApp.</p></body></html>');
    res.type('html');
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Vincular consultor</title>
<style>
body{background:#111;color:#eee;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:95vh;margin:0}
.wrap{text-align:center;max-width:420px}
input{padding:14px;font-size:18px;width:100%;border:1px solid #444;border-radius:8px;background:#222;color:#eee;text-align:center;margin:12px 0;box-sizing:border-box}
button{padding:14px 40px;font-size:16px;background:#25D366;color:#111;border:none;border-radius:8px;cursor:pointer;font-weight:bold}
p{color:#888;font-size:13px;line-height:1.5}
h2{margin-bottom:0}
.help{background:#1a1a2e;padding:12px;border-radius:8px;margin-top:15px;font-size:12px;color:#666}
</style></head>
<body><div class="wrap">
<h2>🔗 Vincular WhatsApp</h2>
<p style="margin-top:5px">Ingresa tu número y recibe un código en tu teléfono</p>
<form method="POST" action="/pair">
<input type="tel" name="phone" placeholder="521234567890" required>
<button type="submit">Obtener código</button>
</form>
<p>Incluye código de país (ej: 52 México, 34 España, 1 USA). Sin +, sin espacios, sin guiones.</p>

</div></body></html>`);
});

app.post('/pair', async (req, res) => {
    if (clientReady) return res.send('Ya conectado');
    const phone = req.body.phone?.replace(/[^0-9]/g, '');
    if (!phone || phone.length < 7) return res.status(400).send('Número inválido');

    pendingPairingCode = null;
    pendingPairingError = null;
    pairingInProgress = true;

    // Lanzar en background (no esperar)
    startPairing(phone);

    res.type('html');
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Generando código...</title>
<style>
body{background:#111;color:#eee;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:95vh;margin:0}
.wrap{text-align:center}
.spinner{border:4px solid #333;border-top:4px solid #25D366;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:20px auto}
@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
p{color:#888}
a{color:#25D366}
</style></head>
<body><div class="wrap">
<h2>Generando código...</h2>
<div class="spinner"></div>
<p id="msg">Iniciando navegador, espera unos segundos...</p>
<script>
let pollCount = 0;
let maxPolls = 180; // 3 minutos
async function check() {
    if (pollCount++ > maxPolls) {
        document.body.innerHTML = '<div class="wrap"><h2>Tiempo de espera agotado</h2><p>No se pudo generar el código. <a href="/pair">Intentar de nuevo</a></p></div>';
        return;
    }
    try {
        let r = await fetch('/pair-data');
        let d = await r.json();
        if (d.error) {
            document.body.innerHTML = '<div class="wrap"><h2>Error</h2><p>' + d.error + '</p><a href="/pair">Intentar de nuevo</a></div>';
            return;
        }
        if (d.code) {
            document.body.innerHTML = '<div class="wrap"><h2>📱 Código de 8 caracteres</h2><code style="font-size:36px;background:#1a1a2e;padding:20px 50px;border-radius:12px;display:inline-block;margin:20px 0;color:#25D366;letter-spacing:10px;font-weight:bold;border:2px solid #25D366">' + d.code + '</code><div class="instructions" style="background:#222;padding:20px;border-radius:8px;text-align:left;max-width:400px;margin:15px auto;font-size:14px;color:#ccc;line-height:1.6"><b style="color:#25D366">1.</b> En tu teléfono abre WhatsApp<br><b style="color:#25D366">2.</b> Ve a <b>Ajustes → Dispositivos vinculados</b><br><b style="color:#25D366">3.</b> Toca <b>Vincular un dispositivo</b><br><b style="color:#25D366">4.</b> Elige <b>Vincular con número de teléfono</b><br><b style="color:#25D366">5.</b> Ingresa este código</div><p style="color:#666">La página se actualizará automáticamente cuando se vincule.</p>';
            // Poll connection status
            setInterval(async () => {
                try {
                    let r = await fetch('/qr-data');
                    let d = await r.json();
                    if (d.connected) location.href = '/pair';
                } catch(e) {}
            }, 3000);
            return;
        }
        if (pollCount < 10) document.getElementById('msg').textContent = 'Iniciando navegador, espera unos segundos...';
        else if (pollCount < 30) document.getElementById('msg').textContent = 'Cargando WhatsApp Web...';
        else document.getElementById('msg').textContent = 'Generando código de vinculación...';
    } catch(e) {}
    setTimeout(check, 1000);
}
check();
</script>
</div></body></html>`);
});

app.get('/qr', (req, res) => {
    res.redirect('/pair');
});

app.get('/qr-data', (req, res) => {
    res.json({ qr: null, connected: clientReady });
});

app.get('/pair-data', (req, res) => {
    if (clientReady) return res.json({ connected: true, code: null, error: null });
    if (pendingPairingError) return res.json({ connected: false, code: null, error: pendingPairingError });
    if (pendingPairingCode) return res.json({ connected: false, code: pendingPairingCode, error: null });
    res.json({ connected: false, code: null, error: null });
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Guardar sesión antes de que Render mate el proceso
let sessionSaveInProgress = false;

process.on('SIGTERM', async () => {
    console.log('SIGTERM — guardando sesión...');
    const forceExit = setTimeout(() => process.exit(0), 25000);
    if (everConnected) {
        const dir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
        if (sessionSaveInProgress) {
            console.log('SIGTERM — backup ya en progreso, esperando...');
            return; // forceExit se encargará si tarda demasiado
        }
        sessionSaveInProgress = true;
        try {
            await store.saveSession(SESSION_KEY, dir);
            console.log('SIGTERM — backup completado');
        } catch (e) {
            console.log('SIGTERM — error backup:', e.message);
        }
        clearTimeout(forceExit);
        process.exit(0);
    } else {
        clearTimeout(forceExit);
        process.exit(0);
    }
});

app.listen(PORT, () => {
    console.log('Servidor en puerto', PORT);
    startClient();
    startKeepAlive();
});
