import Logger from './logger';

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
    constructor(label: string, ms: number) {
        super(`${label} timed out after ${ms}ms`);
        this.name = 'TimeoutError';
    }
}

export function isValidCoinSymbol(coin: string): boolean {
    const regex = /^[A-Z]{3,8}$/;
    return regex.test(coin);
}

export function isValidHyperliquidAddress(wallet: string): boolean {
    const regex = /^0x[0-9a-f]{40}$/i;
    return regex.test(wallet);
}

export function formatCurrency(value: number): string {
    const abs = Math.abs(value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    const prefix = value < 0 ? '-' : '';
    return `${prefix}$${abs}`;
}

export function capitalize(val: string): string {
    return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

export function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function formatTimeAgo(timestampMs: number): string {
    const diffMs = Date.now() - timestampMs;
    if (diffMs < 0) return 'just now';

    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (years > 0) {
        const remainingMonths = Math.floor((days - years * 365) / 30);
        return remainingMonths > 0 ? `${years}y, ${remainingMonths}mo ago` : `${years}y ago`;
    }
    if (months > 0) {
        const remainingDays = days - months * 30;
        return remainingDays > 0 ? `${months}mo, ${remainingDays}d ago` : `${months}mo ago`;
    }
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
}

export function formatDate(date: Date | null): string {
    if (!date) return 'Unknown';
    return date.toISOString().split('T')[0];
}

export interface RetryOptions {
    attempts: number;
    delayMs?: number;
    backoffMultiplier?: number;
}

const defaultOptions: Required<Omit<RetryOptions, 'label'>> = {
    attempts: 3,
    delayMs: 1000,
    backoffMultiplier: 2
};

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions, logger: Logger): Promise<T> {
    const { attempts, delayMs, backoffMultiplier } = { ...defaultOptions, ...options };
    let lastError: any;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation();
        } catch (err: any) {
            lastError = err;
            if (attempt === attempts) break;
            const delay = delayMs * Math.pow(backoffMultiplier, attempt - 1);
            const errMsg = err?.message || String(err);
            logger.warn(`Retry ${attempt}/${attempts} failed: ${errMsg}. Next attempt in ${delay}ms`);
            await sleep(delay);
        }
    }

    throw lastError;
}
