import Tg from '../services/telegram';
import { Mutex } from './mutex';
import ScreenshotService from '../services/screenshoter';
import { Runner } from './runner';
import { sleep } from './utils';

export interface ChatChannel {
    chatId: number;
    topicId?: number;
}

export abstract class Tracker extends Runner {
    protected screenshoter: ScreenshotService;
    protected screenshotEnabled = false;

    protected tg: Tg;
    protected channels: ChatChannel[];

    protected running = false;
    protected flushMutex = new Mutex();
    protected monitorTask?: Promise<void>;

    protected lastDataTimestamp: number = Date.now();
    protected lastScanTimestamp: number = Date.now();
    protected alertNoDataInterval: NodeJS.Timeout | null = null;
    private restartCount = 0;
    private scanStallCount = 0;

    constructor(tg: Tg, channels: ChatChannel[], screenshotEnabled = false) {
        super();
        this.tg = tg;
        this.channels = channels;
        this.screenshotEnabled = screenshotEnabled;
        this.screenshoter = ScreenshotService.getInstance();
    }

    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;

    isActive(): boolean {
        return this.running;
    }

    isHealthy(noDataCntThreshold: number, scanStallCntThreshold = noDataCntThreshold): boolean {
        return this.running && this.restartCount < noDataCntThreshold && this.scanStallCount < scanStallCntThreshold;
    }

    protected async watchDog(timeoutMs: number, recover?: () => Promise<void>): Promise<void> {
        const checkInterval = Math.min(Math.floor(timeoutMs / 3), 60_000);
        let lastCheckedTimestamp = this.lastDataTimestamp;

        while (this.running) {
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
                    lastCheckedTimestamp = this.lastDataTimestamp;
                    this.restartCount = 0;
                }
            } catch (err) {
                this.logger.error(`Error in alertNoData: ${err}`);
            }
            if (!this.running) break;
            await this.cancellableSleep(checkInterval);
        }
    }

    protected async scanWatchDog(timeoutMs: number): Promise<void> {
        const checkInterval = Math.min(Math.floor(timeoutMs / 3), 60_000);

        while (this.running) {
            try {
                const elapsed = Date.now() - this.lastScanTimestamp;
                if (elapsed >= timeoutMs) {
                    this.scanStallCount++;
                    this.logger.warn(
                        `Scan loop stall detected: no scan completed for ${Math.round(elapsed / 1000)}s (stall count: ${this.scanStallCount})`
                    );
                    await this.tg.sendNoScanAlert(this.name, timeoutMs, this.scanStallCount);
                } else if (this.scanStallCount > 0) {
                    this.scanStallCount = 0;
                }
            } catch (err) {
                this.logger.error(`Error in scanWatchDog: ${err}`);
            }
            if (!this.running) break;
            await this.cancellableSleep(checkInterval);
        }
    }

    protected async cancellableSleep(ms: number): Promise<void> {
        const checkInterval = 1000;
        const iterations = Math.floor(ms / checkInterval);
        const remainder = ms % checkInterval;

        for (let i = 0; i < iterations; i++) {
            if (!this.running) {
                this.logger.info('cancellableSleep: sleep interrupted by stop request.');
                return;
            }
            await sleep(checkInterval);
        }

        if (remainder > 0 && this.running) await sleep(remainder);
    }
}
