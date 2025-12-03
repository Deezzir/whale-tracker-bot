export class Mutex {
    private locked = false;
    private queue: (() => void)[] = [];

    async acquire(): Promise<() => void> {
        return new Promise<() => void>((resolve) => {
            if (!this.locked) {
                this.locked = true;
                resolve(() => this.release());
            } else {
                this.queue.push(() => resolve(() => this.release()));
            }
        });
    }

    private release(): void {
        const next = this.queue.shift();
        if (next) {
            next();
        } else {
            this.locked = false;
        }
    }

    async runExclusive<T>(callback: () => Promise<T>): Promise<T> {
        const release = await this.acquire();
        try {
            return await callback();
        } finally {
            release();
        }
    }
}
