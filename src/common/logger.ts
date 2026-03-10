import { config } from '../config';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export default class Logger {
    private module: string;
    private logsDir = join(process.cwd(), 'logs');
    private logFileEnabled = config.logFileEnabled;

    constructor(module: string) {
        this.module = module;
        if (this.logFileEnabled) {
            mkdirSync(this.logsDir, { recursive: true });
        }
    }

    private getLogFilePath(): string {
        const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        return join(this.logsDir, `${date}.log`);
    }

    private formatTimestamp(): string {
        return new Date().toISOString();
    }

    private log(level: LogLevel, module: string, message: string, data?: unknown): void {
        const timestamp = this.formatTimestamp();
        const prefix = `[${timestamp}] [${level}] [${module}]`;
        const line =
            data !== undefined
                ? `${prefix} ${message} ${typeof data === 'string' ? data : JSON.stringify(data)}`
                : `${prefix} ${message}`;

        if (data !== undefined) {
            console.log(`${prefix} ${message}`, data);
        } else {
            console.log(`${prefix} ${message}`);
        }
        if (this.logFileEnabled) appendFileSync(this.getLogFilePath(), line + '\n');
    }

    public info(message: string, data?: unknown) {
        this.log('INFO', this.module, message, data);
    }
    public warn(message: string, data?: unknown) {
        this.log('WARN', this.module, message, data);
    }
    public error(message: string, data?: unknown) {
        this.log('ERROR', this.module, message, data);
    }
    public debug(message: string, data?: unknown) {
        this.log('DEBUG', this.module, message, data);
    }
}
