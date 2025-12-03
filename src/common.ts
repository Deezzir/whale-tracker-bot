export function logInfo(msg: string) {
    console.log(`[INFO] ${msg}`);
}

export function logError(msg: string) {
    console.error(`[ERROR] ${msg}`);
}

export function logWarn(msg: string) {
    console.warn(`[WARN] ${msg}`);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithBackoff<T>(operation: () => Promise<T>, retries = 5, delay_ms = 1000): Promise<T> {
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
