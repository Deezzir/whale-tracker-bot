import puppeteer, { type Browser } from 'puppeteer';
import Logger from '../common/logger';
import { config } from '../config';

const logger = new Logger('screenshot');

export default class ScreenshotService {
    private browser: Browser | null = null;

    async start(): Promise<void> {
        if (this.browser) return;
        this.browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });
        logger.info('Browser launched');
    }

    async stop(): Promise<void> {
        if (!this.browser) return;
        await this.browser.close();
        this.browser = null;
        logger.info('Browser closed');
    }

    async capture(url: string): Promise<Buffer | null> {
        try {
            if (!this.browser) await this.start();

            const page = await this.browser!.newPage();
            try {
                await page.setViewport({ width: 1280, height: 1400 });
                await page.setUserAgent({ userAgent: config.puppeteer.userAgent });
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                });

                await page.goto(url, { waitUntil: 'networkidle2' });
                await page.waitForSelector('body', { timeout: 10_000 });

                const screenshot = await page.screenshot({ type: 'png' });
                return Buffer.from(screenshot);
            } finally {
                await page.close();
            }
        } catch (err) {
            logger.error(`Screenshot failed for ${url}: ${err}`);
            return null;
        }
    }
}
