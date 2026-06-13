const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const BUCKET = 'session-bucket';

const EXCLUDES = [
    '--exclude=Cache', '--exclude=Code Cache', '--exclude=GPUCache',
    '--exclude=CacheStorage', '--exclude=GrShaderCache', '--exclude=ShaderCache',
    '--exclude=Dictionaries', '--exclude=BlobStorage', '--exclude=VideoDecodeStats',
];

async function _packDir(srcDir, dstFile) {
    const dirName = path.basename(srcDir);
    const parentDir = path.dirname(srcDir);
    console.log('[Store] empaquetando con tar...');
    // tar sale con código 1 si un archivo cambia durante la lectura.
    // LevelDB tolera lecturas concurrentes (crash recovery built-in).
    // Gzip (-z) reduce ~25 MB a ~5 MB.
    try {
        await execFileP('tar', ['-czf', dstFile, ...EXCLUDES, '-C', parentDir, dirName], { timeout: 120000 });
    } catch (e) {
        if (fs.existsSync(dstFile) && fs.statSync(dstFile).size > 0) {
            console.log('[Store] tar creado (con avisos:', e.message.split('\n')[0].slice(0, 80) + ')');
            return;
        }
        throw e;
    }
    console.log('[Store] tar creado');
}

async function _unpackDir(srcFile, dstDir) {
    await execFileP('tar', ['-xzf', srcFile, '-C', dstDir], { timeout: 120000 });
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
        const tmpFile = path.join(path.dirname(sourceDir), `session-${key}.tar.gz`);
        try {
            await _packDir(sourceDir, tmpFile);
            const stat = fs.statSync(tmpFile);
            console.log('[Store] tar:', (stat.size / 1024).toFixed(1), 'KB');

            const buffer = fs.readFileSync(tmpFile);
            await this._ensureBucket();
            const { error } = await this.db.storage.from(BUCKET).upload(`${key}.tar.gz`, buffer, { upsert: true });
            if (error) return console.log('[Store] Storage upload error:', error.message);

            // Eliminar formato antiguo .tar si existe
            await this.db.storage.from(BUCKET).remove([`${key}.tar`]).catch(() => {});

            console.log('[Store] Sesión guardada');
        } catch (e) {
            console.log('[Store] saveSession error:', e.message);
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
    }

    async restoreSession(key, destDir) {
        const tmpFile = path.join(destDir, `session-${key}.tar.gz`);
        const oldFile = path.join(destDir, `session-${key}.tar`);
        try {
            console.log('[Store] restoreSession key:', key, 'destDir:', destDir);
            await this._ensureBucket();

            // Intentar nuevo formato .tar.gz; si no existe, probar .tar (transición)
            let { data, error } = await this.db.storage.from(BUCKET).download(`${key}.tar.gz`);
            let format = 'tar.gz';
            if (error || !data) {
                const old = await this.db.storage.from(BUCKET).download(`${key}.tar`);
                if (!old.error && old.data) {
                    data = old.data;
                    error = null;
                    format = 'tar';
                }
            }

            if (error || !data) {
                return console.log('[Store] No hay sesión en Storage') || false;
            }

            const buffer = Buffer.from(await data.arrayBuffer());
            console.log('[Store] Descargado:', (buffer.length / 1024).toFixed(1), 'KB');

            await fs.promises.mkdir(destDir, { recursive: true });
            const sessionDir = path.join(destDir, `session-${key}`);
            await fs.promises.mkdir(sessionDir, { recursive: true });

            const saveFile = format === 'tar.gz' ? tmpFile : oldFile;
            fs.writeFileSync(saveFile, buffer);
            if (buffer.length < 2048) {
                console.log('[Store] backup muy pequeño, podría estar vacío');
            }

            await _unpackDir(saveFile, destDir);
            console.log('[Store] Sesión restaurada');

            // Si era .tar, convertirlo a .tar.gz para futuros restores
            if (format === 'tar') {
                try {
                    const gzFile = tmpFile;
                    await _packDir(sessionDir, gzFile);
                    const gzBuf = fs.readFileSync(gzFile);
                    await this.db.storage.from(BUCKET).upload(`${key}.tar.gz`, gzBuf, { upsert: true });
                    await this.db.storage.from(BUCKET).remove([`${key}.tar`]).catch(() => {});
                    console.log('[Store] Backup convertido a .tar.gz');
                } catch (_) {}
            }

            return true;
        } catch (e) {
            console.log('[Store] restoreSession error:', e.message);
            return false;
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
            try { fs.unlinkSync(oldFile); } catch (_) {}
        }
    }

    async sessionExists(key) {
        try {
            await this._ensureBucket();
            const { data, error } = await this.db.storage.from(BUCKET).list('', { search: `${key}.tar.gz` });
            if (!error && data?.length) return true;
            // También verificar formato antiguo .tar
            const { data: data2 } = await this.db.storage.from(BUCKET).list('', { search: `${key}.tar` });
            return !!data2?.length;
        } catch { return false; }
    }

    async deleteSession(key) {
        const { error } = await this.db.storage.from(BUCKET).remove([`${key}.tar.gz`, `${key}.tar`]);
        if (error) console.log('[Store] deleteSession error:', error.message);
    }
}

module.exports = SupabaseStore;
