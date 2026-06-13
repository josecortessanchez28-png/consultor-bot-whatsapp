const { createClient } = require('@supabase/supabase-js');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUCKET = 'session-bucket';

// Copia el directorio de sesión a un temporal para evitar "Size mismatch"
async function _copyDir(src, dst) {
    await fs.promises.mkdir(dst, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            await _copyDir(s, d);
        } else if (entry.isFile()) {
            try {
                // leer y escribir en chunks para evitar archivos bloqueados
                const content = await fs.promises.readFile(s);
                await fs.promises.writeFile(d, content);
            } catch (_) {
                // ignorar archivos que no se puedan leer (ej: bloqueados por otro proceso)
            }
        }
    }
}

async function _packDir(srcDir, dstFile) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-'));
    try {
        await _copyDir(srcDir, path.join(tmpDir, path.basename(srcDir)));
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
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
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
            await this._ensureBucket();
            const { data, error } = await this.db.storage.from(BUCKET).download(`${key}.tar`);
            if (error || !data) {
                return console.log('[Store] No hay sesión en Storage') || false;
            }
            const buffer = Buffer.from(await data.arrayBuffer());
            fs.writeFileSync(tmpFile, buffer);
            console.log('[Store] Descargado:', (buffer.length / 1024).toFixed(1), 'KB');

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
