import { Tracker } from './common/tracker';
import Logger from './common/logger';
import http from 'node:http';

const logger = new Logger('health');

const HEALTH_ENDPOINT = '/healthz';

class HealthService {
    private static readonly NO_DATA_CNT_THRESHOLD = 3;
    private static readonly SCAN_STALL_CNT_THRESHOLD = 2;

    private trackers: Tracker[];
    private port: number;
    private server: http.Server;
    private checkInterval: NodeJS.Timeout | null = null;

    constructor(port: number, trackers: Tracker[]) {
        this.trackers = trackers;
        this.port = port;

        this.server = http.createServer((req, res) => {
            if (req.url === HEALTH_ENDPOINT) {
                const result = this.checkHealth();

                res.writeHead(result.status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(result.body));
                return;
            }

            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
        });

        this.server.on('close', () => logger.info('The server stopped'));
        this.server.on('listening', () => logger.info('The server started'));
        this.server.on('error', (err) => logger.error(`Server error: ${err}`));
        this.server.on('request', (req) => logger.info(`Received request: ${req.method} ${req.url}`));
    }

    private getStatuses() {
        return this.trackers.map((t) => ({
            name: t.name,
            ok: t.isHealthy(HealthService.NO_DATA_CNT_THRESHOLD, HealthService.SCAN_STALL_CNT_THRESHOLD)
        }));
    }

    private checkHealth() {
        const statuses = this.getStatuses();
        const allOk = statuses.every((s) => s.ok);

        return {
            ok: allOk,
            status: allOk ? 200 : 504,
            body: statuses
        };
    }

    start(callback: (error?: string) => Promise<void>) {
        if (this.server.listening) throw new Error('The server is already listening');
        logger.info(`Starting the server on port: ${this.port}`);
        this.server.listen(this.port);

        this.checkInterval = setInterval(() => {
            const statuses = this.getStatuses();
            const unhealthy = statuses.filter((s) => !s.ok);
            if (unhealthy.length > 0) {
                const message = `Unhealthy service: ${unhealthy.map((s) => s.name).join(', ')}.`;
                logger.error(message);
                void callback(message);
            }
        }, 60_000);
    }

    stop() {
        logger.info(`Stoping the server on port: ${this.port}`);
        if (this.checkInterval) clearInterval(this.checkInterval);
        this.server.close();
    }
}

export default HealthService;
