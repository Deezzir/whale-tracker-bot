import mongoose, { Document, Schema } from 'mongoose';
import Logger from '../../common/logger';

const logger = new Logger('db-hyperliquid');

// Hyperliquid wallet aggregation schema
export type HyperTradeDirection = 'long' | 'short';

interface HyperAggregationDocument extends Document {
    wallet: string;
    coin: string;
    dateKey: string;
    direction: HyperTradeDirection;
    totalNotional: number;
    tradeCount: number;
    lastTradeTime: number;
    lastAlertedAt?: number;
}

export type HyperAggregationRecord = Omit<HyperAggregationDocument, keyof Document> & {
    id: string;
};

export type HyperTradeRecord = {
    wallet: string;
    coin: string;
    notional: number;
    tradeTime: number;
    direction: HyperTradeDirection;
};

const HyperAggregationSchema = new Schema<HyperAggregationDocument>(
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

HyperAggregationSchema.index({ wallet: 1, coin: 1, dateKey: 1, direction: 1 }, { unique: true });
const HyperAggregationModel =
    mongoose.models.WalletAggregation ||
    mongoose.model<HyperAggregationDocument>('HyperAggregation', HyperAggregationSchema);

// Hyperliquid tracked wallets schema
interface HyperTrackedDocument extends Document {
    wallet: string;
    coin: string;
    totalNotional: number;
    direction: HyperTradeDirection;
    lastCheckedAt: number;
    nextCheckAt?: number;
}

export type HyperTrackedRecord = Omit<HyperTrackedDocument, keyof Document> & {
    id: string;
};

const HyperTrackedSchema = new Schema<HyperTrackedDocument>(
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

const HyperTrackedModel =
    mongoose.models.WalletTracking || mongoose.model<HyperTrackedDocument>('HyperTrack', HyperTrackedSchema);

export default class HyperliquidDBService {
    private static formatDateKey(timestamp: number, windowMs?: number): string {
        if (!windowMs) {
            return new Date(timestamp).toISOString().slice(0, 10);
        }
        const bucketStart = Math.floor(timestamp / windowMs) * windowMs;
        return new Date(bucketStart).toISOString();
    }

    static async isWalletTracked(wallet: string, coin: string, direction: HyperTradeDirection): Promise<boolean> {
        try {
            const doc = await HyperTrackedModel.findOne({ wallet, coin, direction }).lean().exec();
            return doc !== null;
        } catch (error) {
            logger.error(`Error checking tracked wallet ${wallet}: ${error}`);
            throw error;
        }
    }

    static async addUpdateTrackedWallet(
        wallet: string,
        coin: string,
        direction: HyperTradeDirection,
        totalNotional: number,
        checkInterval?: number
    ): Promise<void> {
        try {
            await HyperTrackedModel.updateOne(
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
            logger.error(`Error adding tracked wallet ${wallet}: ${error}`);
            throw error;
        }
    }

    static async getTrackedWallets(): Promise<HyperTrackedRecord[]> {
        try {
            const docs = await HyperTrackedModel.find().lean().exec();
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
            logger.error(`Error retrieving tracked wallets: ${error}`);
            throw error;
        }
    }

    static async getTradeById(id: string): Promise<HyperAggregationRecord | null> {
        try {
            const doc = await HyperAggregationModel.findOne({ _id: new mongoose.Types.ObjectId(id) })
                .lean<HyperAggregationRecord>()
                .exec();
            return doc;
        } catch (error) {
            logger.error(`Error retrieving trade with id ${id}: ${error}`);
            throw error;
        }
    }

    static async addTradesBulk(trades: HyperTradeRecord[], windowMs?: number): Promise<boolean> {
        try {
            const bulkOps = trades.map((trade) => {
                const dateKey = this.formatDateKey(trade.tradeTime, windowMs);
                return {
                    updateOne: {
                        filter: { wallet: trade.wallet, coin: trade.coin, dateKey, direction: trade.direction },
                        update: {
                            $inc: {
                                totalNotional: trade.notional,
                                tradeCount: 1
                            },
                            $set: {
                                lastTradeTime: trade.tradeTime
                            }
                        },
                        upsert: true,
                        setDefaultsOnInsert: true
                    }
                };
            });

            const result = await HyperAggregationModel.bulkWrite(bulkOps, { ordered: false });
            return result.ok === 1;
        } catch (error) {
            logger.error(`Error inserting trade batch: ${error}`);
            throw error;
        }
    }

    static async addTrade(trade: HyperTradeRecord, windowMs?: number): Promise<HyperAggregationRecord> {
        try {
            const dateKey = this.formatDateKey(trade.tradeTime, windowMs);
            const doc = await HyperAggregationModel.findOneAndUpdate(
                { wallet: trade.wallet, coin: trade.coin, dateKey, direction: trade.direction },
                {
                    $inc: {
                        totalNotional: trade.notional,
                        tradeCount: 1
                    },
                    $set: {
                        lastTradeTime: trade.tradeTime
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
                id: String(doc._id),
                wallet: doc.wallet,
                coin: doc.coin,
                dateKey: doc.dateKey,
                direction: doc.direction as HyperTradeDirection,
                totalNotional: doc.totalNotional,
                tradeCount: doc.tradeCount,
                lastTradeTime: doc.lastTradeTime,
                lastAlertedAt: doc.lastAlertedAt
            };
        } catch (error) {
            logger.error(`Error recording trade for wallet ${trade.wallet}: ${error}`);
            throw error;
        }
    }

    static async markTradeAlerted(
        wallet: string,
        coin: string,
        dateKey: string,
        direction: HyperTradeDirection
    ): Promise<void> {
        try {
            await HyperAggregationModel.updateOne(
                { wallet, coin, dateKey, direction },
                {
                    $set: {
                        lastAlertedAt: Date.now()
                    }
                }
            );
        } catch (error) {
            logger.error(
                `Error marking alerted status for wallet ${wallet}, coin ${coin}, dateKey ${dateKey}, direction ${direction}: ${error}`
            );
            throw error;
        }
    }

    static async getExpiredTrackedWallets(): Promise<HyperTrackedRecord[]> {
        try {
            const docs = await HyperTrackedModel.find({ nextCheckAt: { $lte: Date.now() } })
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
            logger.error(`Error retrieving expired tracked wallets: ${error}`);
            throw error;
        }
    }

    static async removeTrackedWallet(
        wallet: string,
        coin: string,
        direction: HyperTradeDirection
    ): Promise<HyperTrackedRecord | null> {
        try {
            const deleted = await HyperTrackedModel.findOneAndDelete({
                wallet,
                coin,
                direction
            });

            if (deleted) {
                logger.info(`Removed tracked wallet ${wallet} / ${coin} / ${direction}`);
            }

            return deleted;
        } catch (error) {
            logger.error(`Error removing tracked wallet ${wallet}: ${error}`);
            return null;
        }
    }

    static async removeTrackedWalletById(id: string): Promise<HyperTrackedRecord | null> {
        try {
            const deleted = await HyperTrackedModel.findByIdAndDelete(id);

            if (deleted) logger.info(`Removed tracked wallet with id ${id}`);
            return deleted;
        } catch (error) {
            logger.error(`Error removing tracked wallet with id ${id}: ${error}`);
            return null;
        }
    }

    static async getTradesToAlert(threshold: number, windowMs?: number): Promise<HyperAggregationRecord[]> {
        try {
            const dateKey = this.formatDateKey(Date.now(), windowMs);
            const docs = await HyperAggregationModel.find(
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
                direction: doc.direction as HyperTradeDirection,
                totalNotional: doc.totalNotional,
                tradeCount: doc.tradeCount,
                lastTradeTime: doc.lastTradeTime,
                lastAlertedAt: doc.lastAlertedAt
            }));
        } catch (error) {
            logger.error(`${error}`);
            throw error;
        }
    }

    static async cleanTrades(ttlMs: number): Promise<void> {
        try {
            const cutoffDate = new Date(Date.now() - ttlMs).toISOString();
            const result = await HyperAggregationModel.deleteMany({ updatedAt: { $lt: cutoffDate } });
            logger.info(`Deleted ${result.deletedCount} old records`);
        } catch (error) {
            logger.error(`${error}`);
            throw error;
        }
    }
}
