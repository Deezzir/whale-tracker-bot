import { Telegraf } from 'telegraf';
import * as common from '../common';
import { getRedisClient } from '../services/redis';

export abstract class Tracker {
    protected bot: Telegraf;
    protected redis = getRedisClient();
    protected monitoring = false;
    protected monitorTask?: Promise<void>;

    constructor(bot: Telegraf) {
        this.bot = bot;
    }

    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;

    isActive(): boolean {
        return this.monitoring;
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
