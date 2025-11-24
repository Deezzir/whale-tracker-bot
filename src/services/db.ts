import mongoose, { Document, Schema } from 'mongoose';
import { config, Environment } from '../config';
import * as common from '../common';

export type TradeDirection = 'long' | 'short';

export interface AggregationResult {
    wallet: string;
    coin: string;
    dateKey: string;
    direction: TradeDirection;
    totalNotional: number;
    tradeCount: number;
}

export interface AggregationRecord extends AggregationResult {
    id: string;
    lastTradeTime: number;
    lastAlertedAt?: number;
}

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

interface WalletTracking extends Document {
    wallet: string;
    coin: string;
    totalNotional: number;
    direction: TradeDirection;
    lastCheckedAt: number;
    nextCheckAt?: number;
}

export interface TrackedWallet {
    id: string;
    wallet: string;
    coin: string;
    totalNotional: number;
    direction: TradeDirection;
    lastCheckedAt: number;
    nextCheckAt?: number;
}

const WalletTrackingSchema = new Schema<WalletTracking>(
    {
        wallet: { type: String, required: true, unique: true },
        coin: { type: String, required: true },
        totalNotional: { type: Number, default: 0 },
        direction: { type: String, required: true, enum: ['long', 'short'] },
        lastCheckedAt: { type: Number, default: 0 },
        nextCheckAt: { type: Number }
    },
    { timestamps: true }
);

const WalletTrackingModel =
    mongoose.models.WalletTracking || mongoose.model<WalletTracking>('WalletTracking', WalletTrackingSchema);

export default class DBService {
    private static formatDateKey(timestamp: number, windowMs?: number): string {
        if (!windowMs) {
            return new Date(timestamp).toISOString().slice(0, 10);
        }
        const bucketStart = Math.floor(timestamp / windowMs) * windowMs;
        return new Date(bucketStart).toISOString();
    }

    static async isWalletTracked(wallet: string, coin: string, direction: TradeDirection): Promise<boolean> {
        try {
            const doc = await WalletTrackingModel.findOne({ wallet, coin, direction }).lean().exec();
            return doc !== null;
        } catch (error) {
            common.logError(`DBService.isWalletTracked: Error checking tracked wallet ${wallet}: ${error}`);
            throw error;
        }
    }

    static async addUpdateTrackedWallet(
        wallet: string,
        coin: string,
        direction: TradeDirection,
        totalNotional: number,
        checkInterval?: number
    ): Promise<void> {
        try {
            await WalletTrackingModel.updateOne(
                { wallet, coin, direction },
                {
                    $set: {
                        lastCheckedAt: Date.now(),
                        nextCheckAt: checkInterval ? Date.now() + checkInterval : 0,
                        totalNotional: totalNotional
                    }
                },
                { upsert: true }
            );
        } catch (error) {
            common.logError(`DBService.addTrackedWallet: Error adding tracked wallet ${wallet}: ${error}`);
            throw error;
        }
    }

    static async getTrackedWallets(): Promise<TrackedWallet[]> {
        try {
            const docs = await WalletTrackingModel.find().lean().exec();
            return docs.map((doc) => ({
                id: String(doc._id),
                wallet: doc.wallet,
                coin: doc.coin,
                totalNotional: doc.totalNotional,
                direction: doc.direction,
                lastCheckedAt: doc.lastCheckedAt,
                nextCheckAt: doc.nextCheckAt
            }));
        } catch (error) {
            common.logError(`DBService.getTrackedWallets: ${error}`);
            throw error;
        }
    }

    static async getTradeById(id: string): Promise<AggregationRecord | null> {
        try {
            const doc = await WalletAggregationModel.findOne({ _id: new mongoose.Types.ObjectId(id) })
                .lean<AggregationRecord>()
                .exec();
            return doc;
        } catch (error) {
            common.logError(`DBService.getTradeById: Error retrieving trade with id ${id}: ${error}`);
            throw error;
        }
    }

    static async addTrade(
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

    static async markTradeAlerted(
        wallet: string,
        coin: string,
        dateKey: string,
        direction: TradeDirection
    ): Promise<void> {
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

    static async getExpiredTrackedWallets(): Promise<TrackedWallet[]> {
        try {
            const docs = await WalletTrackingModel.find({ nextCheckAt: { $lte: Date.now() } })
                .lean()
                .exec();
            return docs.map((doc) => ({
                id: String(doc._id),
                wallet: doc.wallet,
                coin: doc.coin,
                totalNotional: doc.totalNotional,
                direction: doc.direction,
                lastCheckedAt: doc.lastCheckedAt,
                nextCheckAt: doc.nextCheckAt
            }));
        } catch (error) {
            common.logError(`DBService.findExpiredTrackedWallets: ${error}`);
            throw error;
        }
    }

    static async removeTrackedWallet(
        wallet: string,
        coin: string,
        direction: TradeDirection
    ): Promise<TrackedWallet | null> {
        try {
            const deleted = await WalletTrackingModel.findOneAndDelete({
                wallet,
                coin,
                direction
            });

            if (deleted) {
                common.logInfo(
                    `DBService.removeTrackedWallet: Removed tracked wallet ${wallet} / ${coin} / ${direction}`
                );
            }

            return deleted;
        } catch (error) {
            common.logError(`DBService.removeTrackedWallet: Error removing tracked wallet ${wallet}: ${error}`);
            return null;
        }
    }

    static async removeTrackedWalletById(id: string): Promise<TrackedWallet | null> {
        try {
            const deleted = await WalletTrackingModel.findByIdAndDelete(id);

            if (deleted) common.logInfo(`DBService.removeTrackedWalletById: Removed tracked wallet with id ${id}`);
            return deleted;
        } catch (error) {
            common.logError(`DBService.removeTrackedWalletById: Error removing tracked wallet with id ${id}: ${error}`);
            return null;
        }
    }

    static async getTradesToAlert(threshold: number, windowMs?: number): Promise<AggregationRecord[]> {
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
                id: String(doc._id),
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

    static async cleanTrades(windowMs: number): Promise<void> {
        try {
            const cutoffDate = new Date(Date.now() - 2 * windowMs).toISOString();
            const result = await WalletAggregationModel.deleteMany({ dateKey: { $lt: cutoffDate } });
            common.logInfo(`DBService.cleanupOldRecords: Deleted ${result.deletedCount} old aggregation records`);
        } catch (error) {
            common.logError(`DBService.cleanupOldRecords: ${error}`);
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
