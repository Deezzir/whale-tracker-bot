import { config } from '../config';
import Logger from '../common/logger';
import fs from 'fs';

const logger = new Logger('Proxy');

export type Proxy = {
    host: string;
    port: string;
    username: string;
    password: string;
};

class ProxyService {
    private path = config.puppeteer.proxiesPath;
    private proxies: Proxy[] = [];
    private usedProxies: Set<number> = new Set();

    constructor() {
        this.proxies = this.loadProxies();
    }

    private loadProxies(): Proxy[] {
        let proxies: Proxy[] = [];

        try {
            const proxyData = fs.readFileSync(this.path, 'utf-8');
            const lines = proxyData
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
            proxies = lines.map((line) => this.parseProxy(line)).filter((p): p is Proxy => p !== null);
            logger.info(`Loaded ${proxies.length} proxies from ${this.path}`);
        } catch (error) {
            logger.warn(`Failed to load proxies: ${error}`);
        }

        if (proxies.length === 0)
            proxies = config.puppeteer.proxies
                .map((proxyStr) => this.parseProxy(proxyStr))
                .filter((p): p is Proxy => p !== null);

        if (proxies.length === 0) logger.warn('No valid proxies found in file or config');

        return proxies;
    }

    private parseProxy(proxyData: string): Proxy | null {
        if (!proxyData.startsWith('http://') && !proxyData.startsWith('https://')) {
            logger.warn(`Skipping invalid proxy format (missing http:// or https://): ${proxyData}`);
            return null;
        }
        const proxyCreds = proxyData.replace(/^https?:\/\//, '');
        const [auth, hostPort] = proxyCreds.split('@');
        const [username, password] = auth.split(':');
        const [host, port] = hostPort.split(':');

        const proxy = { host, port, username, password };
        logger.info(
            `Parsed proxy - Host: ${host}, Port: ${port}, Username: ${username} Password: ${password.replace(/./g, '*')}`
        );
        return proxy;
    }

    public getRandomProxy(): Proxy | null {
        if (this.proxies.length === 0) {
            logger.warn('No proxies available');
            return null;
        }

        const availableProxies = this.proxies.filter((_, index) => !this.usedProxies.has(index));
        if (availableProxies.length === 0) {
            logger.warn('All proxies have been used, resetting used proxies');
            this.usedProxies.clear();
            return this.getRandomProxy();
        }

        const randomIndex = Math.floor(Math.random() * availableProxies.length);
        const proxyIndex = this.proxies.indexOf(availableProxies[randomIndex]);
        this.usedProxies.add(proxyIndex);
        return availableProxies[randomIndex];
    }
}

export default new ProxyService();
