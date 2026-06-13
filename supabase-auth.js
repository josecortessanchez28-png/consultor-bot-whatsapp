const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'session-bucket';

class SupabaseAuthStrategy {
    constructor() {
        this.db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        this.client = null;
        this._tokens = null;
    }

    setup(client) {
        this.client = client;
    }

    async beforeBrowserInitialized() {
    }

    async afterBrowserInitialized() {
    }

    async onAuthenticationNeeded() {
        if (this._tokens) {
            await this.client.pupPage.evaluate((t) => {
                for (const [k, v] of Object.entries(t)) {
                    try { localStorage.setItem(k, v); } catch (_) {}
                }
            }, this._tokens);
            return { failed: false, restart: true };
        }
        try {
            const { data, error } = await this.db.storage.from(BUCKET).download('auth-tokens.json');
            if (!error && data) {
                const raw = Buffer.from(await data.arrayBuffer()).toString();
                this._tokens = JSON.parse(raw);
                await this.client.pupPage.evaluate((t) => {
                    for (const [k, v] of Object.entries(t)) {
                        try { localStorage.setItem(k, v); } catch (_) {}
                    }
                }, this._tokens);
                return { failed: false, restart: true };
            }
        } catch (_) {}
        return { failed: false, restart: false };
    }

    async getAuthEventPayload() {
        try {
            return await this.client.pupPage.evaluate(() => {
                const data = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    data[k] = localStorage.getItem(k);
                }
                return data;
            });
        } catch { return undefined; }
    }

    async saveTokens() {
        try {
            const tokens = await this.client.pupPage.evaluate(() => {
                const data = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    data[k] = localStorage.getItem(k);
                }
                return data;
            });
            const json = JSON.stringify(tokens);
            const buffer = Buffer.from(json, 'utf-8');
            await this.db.storage.from(BUCKET).upload('auth-tokens.json', buffer, { upsert: true, contentType: 'application/json' });
            console.log('[auth] Tokens guardados:', Object.keys(tokens).length, 'keys');
        } catch (e) {
            console.log('[auth] Error guardando tokens:', e.message);
        }
    }

    async afterAuthReady() {
        await this.saveTokens();
    }

    async disconnect() {
    }

    async destroy() {
    }

    async logout() {
        try { await this.db.storage.from(BUCKET).remove(['auth-tokens.json']); } catch (_) {}
        this._tokens = null;
    }
}

module.exports = SupabaseAuthStrategy;
