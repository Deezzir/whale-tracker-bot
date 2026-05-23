import HyperliquidDBService, { HyperTradeDirection } from './hyperliquid';
import StakeDBService from './stake';
import PolymarketDBService from './polymarket';
import CoinglassDBService from './coinglass';
import { config, Environment } from '../../config';
import mongoose from 'mongoose';
import Logger from '../../common/logger';

const logger = new Logger('DB');

function getDBName() {
    return config.env === Environment.Development ? config.db.dbName + '-dev' : config.db.dbName;
}

async function ensureIndexesOnStartup(): Promise<void> {
    const modelNames = mongoose.modelNames();
    if (modelNames.length === 0) return;

    const start = performance.now();
    await Promise.all(modelNames.map((modelName) => mongoose.model(modelName).createIndexes()));
    logger.info(`Ensured indexes for ${modelNames.length} models in ${(performance.now() - start).toFixed(1)}ms`);
}

async function connectDB() {
    try {
        await mongoose.connect(config.db.mongodbURI, {
            dbName: getDBName(),
            autoIndex: config.db.autoIndex
        });

        if (config.db.ensureIndexesOnStart) {
            await ensureIndexesOnStartup();
        }

        logger.info(`MongoDB Connected: ${mongoose.connection.host}:${mongoose.connection.port}`);
    } catch (error) {
        logger.error(`MongoDB connection error: ${error}`);
        process.exit(1);
    }
}

async function closeDB() {
    try {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed');
    } catch (error) {
        logger.error(`Error closing MongoDB connection: ${error}`);
    }
}

export type { HyperTradeDirection };
export { HyperliquidDBService, StakeDBService, PolymarketDBService, CoinglassDBService, connectDB, closeDB };
