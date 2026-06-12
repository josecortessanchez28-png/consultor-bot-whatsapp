const { createClient } = require('@supabase/supabase-js');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const unzipper = require('unzipper');

const BUCKET = 'whatsapp-sessions';

class SupabaseStore {
    constructor() {
        const key = process.env.SUPABASE_KEY || '';
        console.log('[SupabaseStore] KEY prefix:', key.slice(0, 12) + '...');
        console.log('[SupabaseStore] URL:', process.env.SUPABASE_URL);
        this.db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        this.initialized = false;
    }

    async _ensureBucket() {
        if (this.initialized) return;
        try {
            const { data: buckets, error } = await this.db.storage.listBuckets();
            if (error) {
                console.log('[SupabaseStore] listBuckets error:', error.message);
                this.initialized = true;
                return;
            }
            if (!buckets?.find(b => b.name === BUCKET)) {
                const { error: createErr } = await this.db.storage.createBucket(BUCKET, { public: false });
                if (createErr) console.log('[SupabaseStore] createBucket error:', createErr.message);
            }
            console.log('[SupabaseStore] Bucket listo');
        } catch (e) {
            console.log('[SupabaseStore] _ensureBucket exception:', e.message);
        }
        this.initialized = true;
    }

    async sessionExists(key) {
        await this._ensureBucket();
        try {
            const { data, error } = await this.db.storage.from(BUCKET).list('', { search: key });
            if (error) {
                console.log('[SupabaseStore] list error:', error.message);
                return false;
            }
            const exists = !!data?.length;
            console.log('[SupabaseStore] sessionExists(' + key + '):', exists);
            return exists;
        } catch (e) {
            console.log('[SupabaseStore] sessionExists exception:', e.message);
            return false;
        }
    }

    async saveSession(key, sourceDir) {
        console.log('[SupabaseStore] saveSession INICIO, sourceDir:', sourceDir);
        const exists = await fs.pathExists(sourceDir);
        console.log('[SupabaseStore] sourceDir exists:', exists);
        if (!exists) {
            console.log('[SupabaseStore] sourceDir NO existe, abortando');
            return;
        }

        await this._ensureBucket();
        const tmpPath = path.join(os.tmpdir(), `tmp-${key}`);
        console.log('[SupabaseStore] tmpPath:', tmpPath);

        try {
            console.log('[SupabaseStore] Creando ZIP...');
            await new Promise((resolve, reject) => {
                const output = fs.createWriteStream(tmpPath);
                const archive = archiver('zip', { zlib: { level: 9 } });
                output.on('close', () => {
                    console.log('[SupabaseStore] ZIP creado, size:', archive.pointer(), 'bytes');
                    resolve();
                });
                archive.on('error', (err) => {
                    console.log('[SupabaseStore] archiver error:', err.message);
                    reject(err);
                });
                archive.pipe(output);
                archive.directory(sourceDir, 'session-consultor-bot');
                archive.finalize();
            }).catch(e => { throw e; });

            console.log('[SupabaseStore] Leyendo ZIP...');
            const buffer = await fs.readFile(tmpPath);
            console.log('[SupabaseStore] Buffer size:', buffer.length, 'bytes');

            const dirContents = await fs.readdir(sourceDir);
            console.log('[SupabaseStore] Contenido del directorio:', dirContents.join(', '));

            console.log('[SupabaseStore] Subiendo a Supabase Storage...');
            const { error: uploadErr } = await this.db.storage.from(BUCKET).upload(key, buffer, {
                contentType: 'application/zip',
                upsert: true,
            });

            if (uploadErr) {
                console.log('[SupabaseStore] Upload error:', uploadErr.message);
                return;
            }

            console.log(`[SupabaseStore] Sesión respaldada (${(buffer.length / 1024).toFixed(0)} KB)`);
        } catch (e) {
            console.log('[SupabaseStore] saveSession error:', e.message);
            console.log('[SupabaseStore] stack:', e.stack);
        } finally {
            try { await fs.remove(tmpPath); } catch (_) {}
        }
    }

    async restoreSession(key, destDir) {
        console.log('[SupabaseStore] restoreSession INICIO, destino:', destDir);
        await this._ensureBucket();
        const tmpPath = path.join(os.tmpdir(), `tmp-${key}`);

        try {
            console.log('[SupabaseStore] Descargando de Supabase...');
            const { data, error } = await this.db.storage.from(BUCKET).download(key);
            if (error) {
                console.log('[SupabaseStore] Download error:', error.message);
                return false;
            }
            if (!data) {
                console.log('[SupabaseStore] No data received');
                return false;
            }

            const buffer = Buffer.from(await data.arrayBuffer());
            console.log('[SupabaseStore] Descargado:', buffer.length, 'bytes');

            await fs.writeFile(tmpPath, buffer);
            await fs.ensureDir(destDir);
            console.log('[SupabaseStore] Extrayendo ZIP...');
            await new Promise((resolve, reject) => {
                fs.createReadStream(tmpPath)
                    .pipe(unzipper.Extract({ path: destDir }))
                    .on('close', () => {
                        console.log('[SupabaseStore] Extracción completa');
                        resolve();
                    })
                    .on('error', (err) => {
                        console.log('[SupabaseStore] Extracción error:', err.message);
                        reject(err);
                    });
            });

            const contents = await fs.readdir(destDir);
            console.log('[SupabaseStore] Contenido extraído:', contents.join(', '));

            console.log(`[SupabaseStore] Sesión restaurada (${(buffer.length / 1024).toFixed(0)} KB)`);
            return true;
        } catch (e) {
            console.log('[SupabaseStore] restoreSession error:', e.message);
            console.log('[SupabaseStore] stack:', e.stack);
            return false;
        } finally {
            try { await fs.remove(tmpPath); } catch (_) {}
        }
    }
}

module.exports = SupabaseStore;
