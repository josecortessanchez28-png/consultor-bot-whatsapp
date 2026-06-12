const fs = require('fs-extra');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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

    async sessionExists({ session }) {
        await this._ensureBucket();
        try {
            const { data } = await this.db.storage.from(BUCKET).list('', { search: `${session}.zip` });
            return !!data?.length;
        } catch { return false; }
    }

    async save({ session }) {
        await this._ensureBucket();
        const filePath = `${session}.zip`;
        try {
            if (await fs.pathExists(filePath)) {
                const buffer = await fs.readFile(filePath);
                await this.db.storage.from(BUCKET).upload(`${session}.zip`, buffer, {
                    contentType: 'application/zip',
                    upsert: true,
                });
            }
        } catch (e) {
            console.error('SupabaseStore.save error:', e.message);
        }
    }

    async extract({ session, path: destPath }) {
        await this._ensureBucket();
        try {
            const { data } = await this.db.storage.from(BUCKET).download(`${session}.zip`);
            if (data) {
                const buffer = Buffer.from(await data.arrayBuffer());
                await fs.writeFile(destPath, buffer);
            }
        } catch (e) {
            console.error('SupabaseStore.extract error:', e.message);
        }
    }

    async delete({ session }) {
        await this._ensureBucket();
        try {
            await this.db.storage.from(BUCKET).remove([`${session}.zip`]);
        } catch {}
    }
}

module.exports = SupabaseStore;
