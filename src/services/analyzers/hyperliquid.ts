import { Analyzer } from '../../common/analyzer';
import { config } from '../../config';

export default class HyperliquidAnalyzer extends Analyzer {
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.logger.info('Analysis started');

        this.analyzeTask = this.mainLoop();
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;

        await this.analyzeTask?.catch((error) => this.logger.error(`Error while awaiting monitor task: ${error}`));
        this.analyzeTask = undefined;
        this.logger.info('Analysis stopped');
    }

    private async mainLoop(): Promise<void> {
        const checkLoop = async () => {
            while (this.running) {
                try {
                } catch (error) {
                    this.logger.error(`Failed to run analysis: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.hyperliquid.analyzeIntervalMs);
            }
        };

        await Promise.all([checkLoop()]);
    }
}
