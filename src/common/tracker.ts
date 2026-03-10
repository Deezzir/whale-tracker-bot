import Tg from '../services/telegram';
import { getRedisClient } from '../services/redis';
import { config } from '../config';
import Logger from './logger';
import { sleep } from './utils';
import { Mutex } from './mutex';

export abstract class Tracker {
    protected name: string = this.constructor.name;

    protected logger = new Logger(this.name);
    protected tg: Tg;

    protected redis = getRedisClient();
    protected monitoring = false;
    protected flushMutex = new Mutex();
    protected monitorTask?: Promise<void>;
    protected lastDataTimestamp: number = Date.now();
    protected alertNoDataInterval: NodeJS.Timeout | null = null;

    constructor(tg: Tg) {
        this.tg = tg;
    }

    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;

    isActive(): boolean {
        return this.monitoring;
    }

    protected async alertNoData(timeoutMs: number, forceReconnect?: () => Promise<void>): Promise<void> {
        const checkInterval = 5 * 60 * 1000;

        while (this.monitoring) {
            try {
                const now = Date.now();
                if (now - this.lastDataTimestamp >= timeoutMs) {
                    this.logger.warn('No data received within the specified timeout. Sending alert.');
                    await this.tg.sendMessage(
                        config.telegram.ownerUserID,
                        `⚠️ Alert: No data received for ${Math.floor(timeoutMs / 60000)} minutes from ${this.name}.`
                    );
                }
                if (forceReconnect) void forceReconnect();
            } catch (err) {
                this.logger.error(`Error in alertNoData: ${err}`);
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
                this.logger.info('cancellableSleep: sleep interrupted by stop request.');
                return;
            }
            await sleep(checkInterval);
        }

        if (remainder > 0 && this.monitoring) await sleep(remainder);
    }
}
