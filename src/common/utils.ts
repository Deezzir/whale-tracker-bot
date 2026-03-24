export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
    constructor(label: string, ms: number) {
        super(`${label} timed out after ${ms}ms`);
        this.name = 'TimeoutError';
    }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation'): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function retryWithBackoff<T>(operation: () => Promise<T>, retries = 3, delay_ms = 1000): Promise<T> {
    try {
        await sleep(delay_ms);
        return await operation();
    } catch (error: any) {
        if (retries === 0 || !error.toString().includes('429')) {
            throw error;
        }
        return retryWithBackoff(operation, retries - 1, delay_ms * 3);
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

export function formatDate(date: Date | null): string {
    if (!date) return 'Unknown';
    return date.toISOString().split('T')[0];
}
