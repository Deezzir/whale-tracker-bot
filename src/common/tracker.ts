import { Telegraf } from 'telegraf';
import * as common from '../common';
import { getRedisClient } from '../services/redis';
import { config } from '../config';

export abstract class Tracker {
    protected bot: Telegraf;
    protected redis = getRedisClient();
    protected monitoring = false;
    protected monitorTask?: Promise<void>;
    protected lastDataTimestamp: number = Date.now();
    protected alertNoDataInterval: NodeJS.Timeout | null = null;

    constructor(bot: Telegraf) {
        this.bot = bot;
    }

    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;

    isActive(): boolean {
        return this.monitoring;
    }

    protected async alertNoData(timeoutMs: number): Promise<void> {
        const checkInterval = 1 * 60 * 1000; // 1 minutes

        while (this.monitoring) {
            try {
                const now = Date.now();
                if (now - this.lastDataTimestamp >= timeoutMs) {
                    common.logWarn('No data received within the specified timeout. Sending alert.');
                    await this.bot.telegram.sendMessage(
                        config.telegram.ownerUserID,
                        `⚠️ Alert: No data received for ${Math.floor(timeoutMs / 60000)} minutes from ${this.constructor.name}.`
                    );
                }
            } catch (err) {
                common.logError(`Error in alertNoData: ${err}`);
            }
            if (!this.monitoring) break;
            await this.cancellableSleep(checkInterval);
        }
    }

    protected async cancellableSleep(ms: number): Promise<void> {
        const checkInterval = 1000;
        const iterations = Math.floor(ms / checkInterval);
        const remainder = ms % checkInterval;

        for (let i = 0; i < iterations; i++) {
            if (!this.monitoring) {
                common.logInfo('cancellableSleep: sleep interrupted by stop request.');
                return;
            }
            await common.sleep(checkInterval);
        }

        if (remainder > 0 && this.monitoring) await common.sleep(remainder);
    }
}
