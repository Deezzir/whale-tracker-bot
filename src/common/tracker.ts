import Tg from '../services/telegram';
import { getRedisClient } from '../services/redis';
import Logger from './logger';
import { sleep } from './utils';
import { Mutex } from './mutex';
import ScreenshotService from '../services/screenshoter';

export interface ChatChannel {
    chatId: number;
    topicId?: number;
}

export abstract class Tracker {
    public name: string = this.constructor.name;

    protected screenshoter: ScreenshotService;
    protected useProxy: boolean;
    protected logger = new Logger(this.name);
    protected tg: Tg;
    protected channels: ChatChannel[];

    protected redis = getRedisClient();
    protected monitoring = false;
    protected flushMutex = new Mutex();
    protected monitorTask?: Promise<void>;

    protected lastDataTimestamp: number = Date.now();
    protected alertNoDataInterval: NodeJS.Timeout | null = null;
    private restartCount = 0;

    constructor(tg: Tg, channels: ChatChannel[], useProxy = false, useProxyForScreenshots = false) {
        this.tg = tg;
        this.channels = channels;
        this.useProxy = useProxy;
        this.screenshoter = new ScreenshotService(useProxyForScreenshots);
    }

    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;

    isActive(): boolean {
        return this.monitoring;
    }

    isHealthy(threshold: number) {
        return this.monitoring && this.restartCount < threshold;
    }

    protected async watchDog(timeoutMs: number, recover?: () => Promise<void>): Promise<void> {
        const checkInterval = Math.min(Math.floor(timeoutMs / 3), 60_000);
        let lastCheckedTimestamp = this.lastDataTimestamp;

        while (this.monitoring) {
            try {
                const now = Date.now();
                if (now - this.lastDataTimestamp >= timeoutMs) {
                    this.logger.warn('No data received within the specified timeout. Sending alert.');
                    this.lastDataTimestamp = now;
                    lastCheckedTimestamp = now;
                    this.restartCount++;
                    await this.tg.sendNoDataAlert(this.name, timeoutMs, this.restartCount);
                    if (recover) recover().catch((err) => this.logger.error(`Error in watchDog recover: ${err}`));
                } else if (this.lastDataTimestamp !== lastCheckedTimestamp) {
                    this.restartCount = 0;
                    lastCheckedTimestamp = this.lastDataTimestamp;
                }
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
