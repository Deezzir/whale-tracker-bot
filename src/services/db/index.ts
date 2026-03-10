import HyperliquidDBService, { HyperTradeDirection } from './hyperliquid';
import StakeDBService from './stake';
import PolymarketDBService from './polymarket';
import { config, Environment } from '../../config';
import mongoose from 'mongoose';
import Logger from '../../common/logger';

const logger = new Logger('DB');

function getDBName() {
    return config.env === Environment.Development ? config.db.dbName + '-dev' : config.db.dbName;
}

async function connectDB() {
    try {
        await mongoose.connect(config.db.mongodbURI, {
            dbName: getDBName(),
            autoIndex: config.env !== Environment.Production
        });

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
export { HyperliquidDBService, StakeDBService, PolymarketDBService, connectDB, closeDB };
