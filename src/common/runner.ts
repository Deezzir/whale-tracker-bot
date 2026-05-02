import Logger from './logger';
import { sleep } from './utils';

export abstract class Runner {
    public name: string = this.constructor.name;

    protected running = false;
    protected logger = new Logger(this.name);

    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;

    isActive(): boolean {
        return this.running;
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
