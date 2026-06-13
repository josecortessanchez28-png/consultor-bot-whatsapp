const { createClient } = require('@supabase/supabase-js');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BUCKET = 'session-bucket';

async function _packDir(srcDir, dstFile) {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-'));
    const tmpDir = path.join(tmpRoot, path.basename(srcDir));
    try {
        // Usar cp -a del sistema (maneja sockets, FIFOs, archivos bloqueados)
        execFileSync('cp', ['-a', srcDir, tmpRoot], { timeout: 30000 });
        const entries = fs.readdirSync(tmpDir);
        console.log('[Store] archivos en sesión:', entries.length);
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(dstFile);
            const archive = archiver('tar', { gzip: false });
            output.on('close', () => resolve());
            archive.on('error', (e) => reject(e));
            archive.pipe(output);
            archive.directory(tmpDir, false);
            archive.finalize();
        });
    } finally {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
}

async function _unpackDir(srcFile, dstDir) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileP = promisify(execFile);
    await execFileP('tar', ['-xf', srcFile, '-C', dstDir], { timeout: 120000 });
}

class SupabaseStore {
    constructor() {
        this.db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    }

    async _ensureBucket() {
        const { data: buckets, error } = await this.db.storage.listBuckets();
        if (error) return console.log('[Store] listBuckets error:', error.message);
        if (!buckets?.find(b => b.name === BUCKET)) {
            const { error: ce } = await this.db.storage.createBucket(BUCKET, { public: false });
            if (ce) console.log('[Store] createBucket error:', ce.message);
            else console.log('[Store] Bucket creado:', BUCKET);
        }
    }

    async saveSession(key, sourceDir) {
        if (!fs.existsSync(sourceDir)) {
            return console.log('[Store] sourceDir no existe:', sourceDir);
        }
        const tmpFile = path.join(path.dirname(sourceDir), `session-${key}.tar`);
        try {
            console.log('[Store] empaquetando con archiver...');
            await _packDir(sourceDir, tmpFile);
            const stat = fs.statSync(tmpFile);
            console.log('[Store] tar creado:', (stat.size / 1024).toFixed(1), 'KB');

            const buffer = fs.readFileSync(tmpFile);
            await this._ensureBucket();
            const { error } = await this.db.storage.from(BUCKET).upload(`${key}.tar`, buffer, { upsert: true });
            if (error) return console.log('[Store] Storage upload error:', error.message);
            console.log('[Store] Sesión guardada');
        } catch (e) {
            console.log('[Store] saveSession error:', e.message);
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
    }

    async restoreSession(key, destDir) {
        const tmpFile = path.join(destDir, `session-${key}.tar`);
        try {
            console.log('[Store] restoreSession key:', key, 'destDir:', destDir);
            await this._ensureBucket();
            const { data, error } = await this.db.storage.from(BUCKET).download(`${key}.tar`);
            if (error || !data) {
                return console.log('[Store] No hay sesión en Storage') || false;
            }
            const buffer = Buffer.from(await data.arrayBuffer());
            console.log('[Store] Descargado:', (buffer.length / 1024).toFixed(1), 'KB');

            // Asegurar que destDir existe
            await fs.promises.mkdir(destDir, { recursive: true });
            // Asegurar que el directorio de sesión existe
            const sessionDir = path.join(destDir, `session-${key}`);
            await fs.promises.mkdir(sessionDir, { recursive: true });

            fs.writeFileSync(tmpFile, buffer);
            if (buffer.length < 2048) {
                console.log('[Store] tar muy pequeño, podría estar vacío');
            }

            await _unpackDir(tmpFile, destDir);
            console.log('[Store] Sesión restaurada');
            return true;
        } catch (e) {
            console.log('[Store] restoreSession error:', e.message);
            return false;
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
    }

    async sessionExists(key) {
        try {
            await this._ensureBucket();
            const { data, error } = await this.db.storage.from(BUCKET).list('', { search: `${key}.tar` });
            return !error && !!data?.length;
        } catch { return false; }
    }
}

module.exports = SupabaseStore;
