import mongoose, { Document, Schema } from 'mongoose';
import { config, Environment } from '../config';
import * as common from '../common';

export type TradeDirection = 'long' | 'short';

interface WalletAggregationDocument extends Document {
    wallet: string;
    coin: string;
    dateKey: string;
    direction: TradeDirection;
    totalNotional: number;
    tradeCount: number;
    lastTradeTime: number;
    lastAlertedAt?: number;
}

const WalletAggregationSchema = new Schema<WalletAggregationDocument>(
    {
        wallet: { type: String, required: true },
        coin: { type: String, required: true },
        dateKey: { type: String, required: true },
        direction: { type: String, required: true, enum: ['long', 'short'] },
        totalNotional: { type: Number, default: 0 },
        tradeCount: { type: Number, default: 0 },
        lastTradeTime: { type: Number, default: 0 },
        lastAlertedAt: { type: Number }
    },
    { timestamps: true }
);

WalletAggregationSchema.index({ wallet: 1, coin: 1, dateKey: 1, direction: 1 }, { unique: true });

const WalletAggregationModel =
    mongoose.models.WalletAggregation ||
    mongoose.model<WalletAggregationDocument>('WalletAggregation', WalletAggregationSchema);

export interface AggregationResult {
    wallet: string;
    coin: string;
    dateKey: string;
    direction: TradeDirection;
    totalNotional: number;
    tradeCount: number;
}

export interface AggregationRecord extends AggregationResult {
    lastTradeTime: number;
    lastAlertedAt?: number;
}

export default class DBService {
    private static formatDateKey(timestamp: number, windowMs?: number): string {
        if (!windowMs) {
            return new Date(timestamp).toISOString().slice(0, 10);
        }
        const bucketStart = Math.floor(timestamp / windowMs) * windowMs;
        return new Date(bucketStart).toISOString();
    }

    static async recordTrade(
        wallet: string,
        coin: string,
        notional: number,
        tradeTime: number,
        direction: TradeDirection,
        windowMs?: number
    ): Promise<AggregationResult> {
        try {
            const dateKey = this.formatDateKey(tradeTime, windowMs);
            const doc = await WalletAggregationModel.findOneAndUpdate(
                { wallet, coin, dateKey, direction },
                {
                    $inc: {
                        totalNotional: notional,
                        tradeCount: 1
                    },
                    $set: {
                        lastTradeTime: tradeTime
                    }
                },
                {
                    new: true,
                    upsert: true,
                    setDefaultsOnInsert: true
                }
            );

            if (!doc) {
                throw new Error('Failed to record wallet aggregation');
            }

            return {
                wallet: doc.wallet,
                coin: doc.coin,
                dateKey: doc.dateKey,
                direction: doc.direction as TradeDirection,
                totalNotional: doc.totalNotional,
                tradeCount: doc.tradeCount
            };
        } catch (error) {
            common.logError(`DBService.recordTrade: Error recording trade for wallet ${wallet}: ${error}`);
            throw error;
        }
    }

    static async markAlerted(wallet: string, coin: string, dateKey: string, direction: TradeDirection): Promise<void> {
        try {
            await WalletAggregationModel.updateOne(
                { wallet, coin, dateKey, direction },
                {
                    $set: {
                        lastAlertedAt: Date.now()
                    }
                }
            );
        } catch (error) {
            common.logError(
                `DBService.markAlerted: Error marking alerted status for wallet ${wallet}, coin ${coin}, dateKey ${dateKey}, direction ${direction}: ${error}`
            );
            throw error;
        }
    }

    static async findAggregationsNeedingAlert(threshold: number, windowMs?: number): Promise<AggregationRecord[]> {
        try {
            const dateKey = this.formatDateKey(Date.now(), windowMs);
            const docs = await WalletAggregationModel.find(
                {
                    dateKey,
                    totalNotional: { $gte: threshold },
                    $or: [{ lastAlertedAt: { $exists: false } }, { lastAlertedAt: null }]
                },
                {
                    wallet: 1,
                    coin: 1,
                    dateKey: 1,
                    direction: 1,
                    totalNotional: 1,
                    tradeCount: 1,
                    lastTradeTime: 1,
                    lastAlertedAt: 1
                }
            )
                .lean()
                .exec();

            return docs.map((doc) => ({
                wallet: doc.wallet,
                coin: doc.coin,
                dateKey: doc.dateKey,
                direction: doc.direction as TradeDirection,
                totalNotional: doc.totalNotional,
                tradeCount: doc.tradeCount,
                lastTradeTime: doc.lastTradeTime,
                lastAlertedAt: doc.lastAlertedAt
            }));
        } catch (error) {
            common.logError(`DBService.findAggregationsNeedingAlert: ${error}`);
            throw error;
        }
    }

    static async cleanupOldAggregations(aggregationWindowMs: number): Promise<void> {
        try {
            const cutoffDate = new Date(Date.now() - 2 * aggregationWindowMs).toISOString();
            const result = await WalletAggregationModel.deleteMany({ dateKey: { $lt: cutoffDate } });
            common.logInfo(`DBService.cleanupOldAggregations: Deleted ${result.deletedCount} old aggregation records`);
        } catch (error) {
            common.logError(`DBService.cleanupOldAggregations: ${error}`);
            throw error;
        }
    }
}

function getDBName() {
    return config.env === Environment.Development ? config.db.dbName + '-dev' : config.db.dbName;
}

export async function connectDB() {
    try {
        await mongoose.connect(config.db.mongodbURI, {
            dbName: getDBName(),
            autoIndex: config.env !== Environment.Production
        });

        common.logInfo(`MongoDB Connected: ${mongoose.connection.host}:${mongoose.connection.port}`);
    } catch (error) {
        common.logError(`MongoDB connection error: ${error}`);
        process.exit(1);
    }
}

export async function closeDB() {
    try {
        await mongoose.connection.close();
        common.logInfo('MongoDB connection closed');
    } catch (error) {
        common.logError(`Error closing MongoDB connection: ${error}`);
    }
}
