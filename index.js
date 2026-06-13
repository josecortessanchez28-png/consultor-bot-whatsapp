require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const SupabaseStore = require('./supabase-store');
const https = require('https');
const bot = require('./bot');
const database = require('./database');

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
let clientStarting = false;
let sessionRestored = false;
let qrCount = 0;
let backupInterval = null;
let currentClient = null;
let pendingPairingCode = null;
let pendingPairingError = null;

function makeClient(phoneNumber) {
    const opts = {
        authStrategy: new LocalAuth({ clientId: SESSION_KEY, dataPath: AUTH_DIR }),
        puppeteer: {
            headless: true,
            protocolTimeout: 120000,
            args: [
                '--single-process',
                '--js-flags=--max-old-space-size=300',
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--no-zygote',
                '--disable-gpu',
                '--disable-features=site-per-process',
                '--disable-extensions',
                '--disable-component-extensions-with-background-pages',
                '--disable-background-networking',
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
    client.on('message_create', (msg) => {
        if (msg.from === 'status@broadcast') return;
        if (msg.from.endsWith('@g.us')) return;
        if (msg.fromMe) return;
        console.log('Msg de', msg.from, 'tipo:', msg.type || msg._data?.type);
        bot.handleMessage(client, msg);
    });

    client.on('qr', async (qr) => {
        if (!pairingInProgress && sessionRestored) {
            qrCount++;
            console.log(`[qr] QR inesperado (intento ${qrCount}/3)`);
            if (qrCount >= 3) {
                console.log('[qr] QR persistente — sesión inválida. Limpiando...');
                clientReady = false;
                sessionRestored = false;
                qrCount = 0;
                const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                try { await store.deleteSession(SESSION_KEY); } catch (_) {}
                if (currentClient) {
                    try { await currentClient.destroy(); } catch (_) {}
                    currentClient = null;
                }
            }
        }
    });

    client.on('auth_failure', async (reason) => {
        console.log('[auth_failure] Fallo de autenticación:', reason);
        clientReady = false;
        pairingInProgress = false;
        if (sessionRestored) {
            sessionRestored = false;
            const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
            try { await store.deleteSession(SESSION_KEY); } catch (_) {}
        }
        if (currentClient) {
            try { await currentClient.destroy(); } catch (_) {}
            currentClient = null;
        }
    });

    client.on('ready', async () => {
        clientReady = true;
        everConnected = true;
        sessionRestored = false;
        qrCount = 0;
        if (backupInterval) clearInterval(backupInterval);
        console.log('WhatsApp conectado correctamente');

        const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);

        // Backup inmediato (tokens ya están en IndexedDB, LevelDB tolera cortes)
        (async () => {
            try {
                console.log('[backup] Guardando copia inmediata...');
                await store.saveSession(SESSION_KEY, sessionDir);
                console.log('[backup] Copia inmediata guardada');
            } catch (e) {
                console.log('[backup] Error en backup inmediato:', e.message);
            }
        })();

        // Backup a los 60s (tras estabilización completa de IndexedDB)
        setTimeout(async () => {
            try {
                console.log('[backup] Guardando copia estable (60s)...');
                await store.saveSession(SESSION_KEY, sessionDir);
                console.log('[backup] Copia estable guardada');
            } catch (e) {
                console.log('[backup] Error en backup 60s:', e.message);
            }
        }, 60000);

        // Backup periódico cada 15 min
        backupInterval = setInterval(async () => {
            try { await store.saveSession(SESSION_KEY, sessionDir); } catch (_) {}
        }, 900000);
    });

    client.on('disconnected', (reason) => {
        console.log('Desconectado:', reason);
        qrCount = 0;
        if (backupInterval) clearInterval(backupInterval);
        backupInterval = null;
        clientReady = false;
        pairingInProgress = false;
    });
}

async function cleanupChromeLocks() {
    const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { fs.unlinkSync(path.join(sessionDir, f)); } catch (_) {}
    }
    const levelDbLock = path.join(sessionDir, 'Default', 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb', 'LOCK');
    try { fs.unlinkSync(levelDbLock); } catch (_) {}
    try { fs.rmSync(path.join(sessionDir, 'Default', 'Cache'), { recursive: true, force: true }); } catch (_) {}
    try { require('child_process').execFileSync('pkill', ['-f', 'chrome'], { timeout: 3000 }); } catch (_) {}
}

async function startClient() {
    while (pairingInProgress) await new Promise(r => setTimeout(r, 1000));
    if (clientStarting || clientReady) return;
    clientStarting = true;

    // Reintentar hasta 20s: el proceso viejo podría estar subiendo el backup en SIGTERM
    let exists = false;
    for (let i = 0; i < 10; i++) {
        exists = await store.sessionExists(SESSION_KEY);
        if (exists) break;
        if (i === 0) console.log('[index] Sin sesión, esperando posible backup de proceso anterior...');
        await new Promise(r => setTimeout(r, 2000));
    }

    if (exists) {
        console.log('[index] Restaurando sesión...');
        await store.restoreSession(SESSION_KEY, AUTH_DIR);
        sessionRestored = true;
        await cleanupChromeLocks();
        await connectClient();

        // Si se restauró una sesión pero los 3 intentos fallaron, el backup está corrupto
        if (sessionRestored && !clientReady) {
            console.log('[index] Sesión restaurada no válida — limpiando backup corrupto de Storage');
            sessionRestored = false;
            const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
            try { await store.deleteSession(SESSION_KEY); } catch (_) {}
            if (currentClient) {
                try { await currentClient.destroy(); } catch (_) {}
                currentClient = null;
            }
            console.log('[index] Backup corrupto eliminado. Ir a /pair para vincular.');
        }
    } else {
        sessionRestored = false;
        console.log('[index] No hay sesión guardada. Ir a /pair para vincular.');
    }

    clientStarting = false;
}

async function connectClient() {
    for (let i = 0; i < 3; i++) {
        try {
            await cleanupChromeLocks();
            if (currentClient) { try { await currentClient.destroy(); } catch (_) {} }
            currentClient = makeClient();
            setupEvents(currentClient);
            await currentClient.initialize();
            console.log('[index] Cliente inicializado');
            return;
        } catch (e) {
            console.log(`[index] Intento ${i + 1}/3 falló:`, e?.message?.slice(0, 100) || e);
            await new Promise(r => setTimeout(r, 8000));
        }
    }
    console.log('[index] No se pudo conectar tras 3 intentos');
}

function startKeepAlive() {
    const url = process.env.RENDER_EXTERNAL_URL || 'https://consultor-bot-whatsapp.onrender.com';
    console.log('KeepAlive cada 4 min');
    const ping = () => https.get(url + '/healthz', () => {}).on('error', () => {});
    ping(); setTimeout(ping, 120000); setInterval(ping, 240000);
}

// ----- Pairing code generation -----

let pairingRunning = false;

async function startPairing(phone) {
    try {
        if (pairingRunning) {
            console.log('[pair] Ya hay un pairing en curso, ignorando');
            return;
        }
        pairingRunning = true;
        pendingPairingCode = null;
        pendingPairingError = null;

        while (clientStarting) {
            console.log('[pair] Esperando connectClient...');
            await new Promise(r => setTimeout(r, 3000));
        }
        pairingInProgress = true;
        sessionRestored = false;

        // Eliminar backup previo de Storage
        try {
            await store.deleteSession(SESSION_KEY);
            console.log('[pair] Backup anterior eliminado de Storage');
        } catch (_) {}

        // Destruir cliente anterior si existe
        if (currentClient) {
            try { await currentClient.destroy(); } catch (_) {}
            currentClient = null;
        }
        clientReady = false;

        // Matar TODOS los procesos Chrome zombies
        try { require('child_process').execFileSync('pkill', ['-9', '-f', 'chrome'], { timeout: 5000 }); } catch (_) {}
        try { require('child_process').execFileSync('pkill', ['-9', '-f', 'Chromium'], { timeout: 5000 }); } catch (_) {}
        await new Promise(r => setTimeout(r, 2000));

        // Borrar el perfil local por completo para evitar conflicto de directorio
        const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(path.join(AUTH_DIR, 'Default'), { recursive: true, force: true }); } catch (_) {}
        console.log('[pair] Perfil local eliminado');

        console.log('[pair] Creando cliente...');
        currentClient = makeClient();
        setupEvents(currentClient);
        await currentClient.initialize();
        console.log('[pair] initialize() completado');

        const page = currentClient.pupPage;
        console.log('[pair] Esperando AuthStore...');
        await page.waitForFunction(() => window.AuthStore !== undefined, { timeout: 60000 });
        console.log('[pair] AuthStore disponible');

        console.log('[pair] Cambiando a modo pairing...');
        for (let i = 0; i < 3 && !pendingPairingCode; i++) {
            try {
                const code = await Promise.race([
                    page.evaluate(async (phoneNumber) => {
                        let u = window.AuthStore?.PairingCodeLinkUtils;
                        let waited = 0;
                        while (!u) {
                            await new Promise(r => setTimeout(r, 200));
                            waited += 200;
                            if (waited > 30000) throw new Error('timeout PairingCodeLinkUtils');
                            u = window.AuthStore?.PairingCodeLinkUtils;
                        }
                        u.setPairingType('ALT_DEVICE_LINKING');
                        await u.initializeAltDeviceLinking();
                        return await u.startAltLinkingFlow(phoneNumber, true);
                    }, phone),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 60s')), 60000)),
                ]);
                if (code && /^[A-Z0-9]{8}$/.test(code)) {
                    console.log('[pair] Código:', code);
                    pendingPairingCode = code;
                    break;
                }
            } catch (e2) {
                console.log(`[pair] Intento ${i + 1} falló:`, e2?.message?.slice(0, 120) || e2);
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        if (!pendingPairingCode) pendingPairingError = 'No se pudo generar el código';
    } catch (e) {
        console.log('[pair] Error:', e?.message || e);
        pendingPairingError = 'Error: ' + (e?.message || e);
    } finally {
        pairingInProgress = false;
        pairingRunning = false;
    }
}

// ----- Rutas Express -----

app.get('/', (req, res) => {
    res.json({ status: clientReady ? 'conectado' : 'conectando' });
});

app.get('/pair', (req, res) => {
    if (clientReady) return res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Conectado</title><style>body{background:#111;color:#eee;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:95vh;margin:0;text-align:center}</style></head><body><h2>Conectado</h2><p>El bot ya está vinculado a WhatsApp.</p></body></html>');
    if (clientStarting) return res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Espera</title><style>body{background:#111;color:#eee;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:95vh;margin:0;text-align:center}</style></head><body><h2>Iniciando sesión...</h2><p>Espera unos segundos y recarga.</p></body></html>');
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
    pairingInProgress = true;
    pendingPairingCode = null;
    pendingPairingError = null;
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
let maxPolls = 180;
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

app.get('/qr', (req, res) => res.redirect('/pair'));
app.get('/qr-data', (req, res) => res.json({ qr: null, connected: clientReady }));
app.get('/pair-data', (req, res) => {
    if (clientReady) return res.json({ connected: true, code: null, error: null });
    if (pendingPairingError) return res.json({ connected: false, code: null, error: pendingPairingError });
    if (pendingPairingCode) return res.json({ connected: false, code: pendingPairingCode, error: null });
    res.json({ connected: false, code: null, error: null });
});
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// ----- Cierre -----

process.on('unhandledRejection', (err) => {
    console.log('[unhandledRejection]', err?.stack || err?.message || err);
});

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
        
        if (active.instanceId === database.INSTANCE_ID) {
            break;
        }
        
        console.log(`[index] Otra instancia (${active.instanceId}) está activa. Esperando...`);
        await new Promise(r => setTimeout(r, 2000));
    }
    
    // Iniciar latidos cada 5s
    setInterval(async () => {
        await database.updateHeartbeat();
    }, 5000);
    await database.updateHeartbeat();
}

process.on('SIGTERM', async () => {
    console.log('SIGTERM - cerrando cliente y respaldando...');
    if (currentClient) {
        // Cerrar Chrome limpiamente primero (flush de IndexedDB a disco)
        try {
            await Promise.race([
                currentClient.destroy(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('destroy timeout')), 10000)),
            ]);
        } catch (e) {
            console.log('[SIGTERM] destroy:', e.message);
        }
        currentClient = null;
        clientReady = false;

        // Backup después de Chrome cerrado — archivos estables
        const sessionDir = path.join(AUTH_DIR, `session-${SESSION_KEY}`);
        try {
            await store.saveSession(SESSION_KEY, sessionDir);
            console.log('[SIGTERM] Backup completado');
        } catch (e) {
            console.log('[SIGTERM] Backup falló:', e.message);
        }
    }
    
    // Liberar latido
    try {
        await database.releaseHeartbeat();
        console.log('[SIGTERM] Latido liberado');
    } catch (_) {}
    
    process.exit(0);
});

async function startApp() {
    console.log('[index] Iniciando instancia:', database.INSTANCE_ID);
    await waitForActiveInstance();
    await startClient();
}

const server = app.listen(PORT, () => {
    console.log('Servidor en puerto', PORT);
    startApp();
    startKeepAlive();
});
