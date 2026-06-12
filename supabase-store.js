const { createClient } = require('@supabase/supabase-js');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');

const BUCKET = 'whatsapp-sessions';

class SupabaseStore {
    constructor() {
        this.db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        this.initialized = false;
    }

    async _ensureBucket() {
        if (this.initialized) return;
        try {
            const { data: buckets } = await this.db.storage.listBuckets();
            if (!buckets?.find(b => b.name === BUCKET)) {
                await this.db.storage.createBucket(BUCKET, { public: false });
            }
        } catch (_) {}
        this.initialized = true;
    }

    async sessionExists(key) {
        await this._ensureBucket();
        try {
            const { data } = await this.db.storage.from(BUCKET).list('', { search: key });
            return !!data?.length;
        } catch { return false; }
    }

    async saveSession(key, sourceDir) {
        await this._ensureBucket();
        if (!await fs.pathExists(sourceDir)) return;
        const tmpPath = path.join(__dirname, `tmp-${key}`);
        try {
            await new Promise((resolve, reject) => {
                const output = fs.createWriteStream(tmpPath);
                const archive = archiver('zip', { zlib: { level: 9 } });
                output.on('close', resolve);
                archive.on('error', reject);
                archive.pipe(output);
                archive.directory(sourceDir, 'session-consultor-bot');
                archive.finalize();
            });
            const buffer = await fs.readFile(tmpPath);
            await this.db.storage.from(BUCKET).upload(key, buffer, {
                contentType: 'application/zip',
                upsert: true,
            });
            console.log(`Sesión respaldada en Supabase (${(buffer.length / 1024).toFixed(0)} KB)`);
        } catch (e) {
            console.error('saveSession error:', e.message);
        } finally {
            await fs.remove(tmpPath).catch(() => {});
        }
    }

    async restoreSession(key, destDir) {
        await this._ensureBucket();
        const tmpPath = path.join(__dirname, `tmp-${key}`);
        try {
            const { data, error } = await this.db.storage.from(BUCKET).download(key);
            if (error || !data) return false;
            const buffer = Buffer.from(await data.arrayBuffer());
            await fs.writeFile(tmpPath, buffer);
            await fs.ensureDir(destDir);
            await new Promise((resolve, reject) => {
                fs.createReadStream(tmpPath)
                    .pipe(unzipper.Extract({ path: destDir }))
                    .on('close', resolve)
                    .on('error', reject);
            });
            console.log(`Sesión restaurada de Supabase (${(buffer.length / 1024).toFixed(0)} KB)`);
            return true;
        } catch (e) {
            console.error('restoreSession error:', e.message);
            return false;
        } finally {
            await fs.remove(tmpPath).catch(() => {});
        }
    }
}

module.exports = SupabaseStore;
