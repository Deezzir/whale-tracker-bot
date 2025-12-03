import mongoose, { Document, Schema } from 'mongoose';
import { config, Environment } from '../config';
import * as common from '../common';

// Hyperliquid wallet aggregation schema
export type TradeDirection = 'long' | 'short';

interface HyperAggregationDocument extends Document {
    wallet: string;
    coin: string;
    dateKey: string;
    direction: TradeDirection;
    totalNotional: number;
    tradeCount: number;
    lastTradeTime: number;
    lastAlertedAt?: number;
}

export type HyperAggregationRecord = Omit<HyperAggregationDocument, keyof Document> & {
    id: string;
};

export type TradeRecord = {
    wallet: string;
    coin: string;
    notional: number;
    tradeTime: number;
    direction: TradeDirection;
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
    direction: TradeDirection;
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

// Stake record schema
export interface SwishBetOutcome {
    odds: number;
    event: {
        live: boolean;
        sport: string;
        competitor: string;
        lineType: string;
        lineValue: number;
        lineName: string;
    };
}

export interface SportBetOutcome {
    odds: number;
    event: {
        live: boolean;
        sport: string;
        name: string;
        abbreviation: string;
        outcome: string;
        market: string;
    };
}

export interface RacingBetOutcome {
    event: {
        live: boolean;
        type: string;
        sport: string;
        venue: string;
        runners: {
            name: string;
            number: number | null;
        }[];
        odds: {
            odds: number;
            type: string;
        }[];
    };
}

export type BetOutcome = SwishBetOutcome | SportBetOutcome | RacingBetOutcome;
export type BetType = 'SwishBet' | 'SportBet' | 'RacingBet';

export interface StakeBetDocument extends Document {
    iid: string;
    type: BetType;
    potentialMultiplier?: number | null;
    amountUSD: number;
    outcomes: BetOutcome[];
    lastAlertedAt?: number;
}

export type StakeBetRecord = Omit<StakeBetDocument, keyof Document> & {
    id: string;
};

const StakeBetSchema = new Schema<StakeBetDocument>(
    {
        type: { type: String, required: true, enum: ['SwishBet', 'SportBet', 'RacingBet'] },
        potentialMultiplier: { type: Number },
        amountUSD: { type: Number, required: true },
        outcomes: { type: [Schema.Types.Mixed], required: true } as any,
        iid: { type: String, required: true, unique: true },
        lastAlertedAt: { type: Number }
    },
    { timestamps: true }
);

export const StakeBetModel =
    mongoose.models.StakeBetRecord || mongoose.model<StakeBetDocument>('StakeBet', StakeBetSchema);

// DB Service
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
            const doc = await HyperTrackedModel.findOne({ wallet, coin, direction }).lean().exec();
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
            common.logError(`DBService.addTrackedWallet: Error adding tracked wallet ${wallet}: ${error}`);
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
            common.logError(`DBService.getTrackedWallets: ${error}`);
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
            common.logError(`DBService.getTradeById: Error retrieving trade with id ${id}: ${error}`);
            throw error;
        }
    }

    static async addTradesBulk(trades: TradeRecord[], windowMs?: number): Promise<boolean> {
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
            common.logError(`DBService.addTradeButch: Error recording trade batch: ${error}`);
            throw error;
        }
    }

    static async addTrade(trade: TradeRecord, windowMs?: number): Promise<HyperAggregationRecord> {
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
                direction: doc.direction as TradeDirection,
                totalNotional: doc.totalNotional,
                tradeCount: doc.tradeCount,
                lastTradeTime: doc.lastTradeTime,
                lastAlertedAt: doc.lastAlertedAt
            };
        } catch (error) {
            common.logError(`DBService.recordTrade: Error recording trade for wallet ${trade.wallet}: ${error}`);
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
            await HyperAggregationModel.updateOne(
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
            common.logError(`DBService.findExpiredTrackedWallets: ${error}`);
            throw error;
        }
    }

    static async removeTrackedWallet(
        wallet: string,
        coin: string,
        direction: TradeDirection
    ): Promise<HyperTrackedRecord | null> {
        try {
            const deleted = await HyperTrackedModel.findOneAndDelete({
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

    static async removeTrackedWalletById(id: string): Promise<HyperTrackedRecord | null> {
        try {
            const deleted = await HyperTrackedModel.findByIdAndDelete(id);

            if (deleted) common.logInfo(`DBService.removeTrackedWalletById: Removed tracked wallet with id ${id}`);
            return deleted;
        } catch (error) {
            common.logError(`DBService.removeTrackedWalletById: Error removing tracked wallet with id ${id}: ${error}`);
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

    static async cleanTrades(ttlMs: number): Promise<void> {
        try {
            const cutoffDate = new Date(Date.now() - ttlMs).toISOString();
            const result = await HyperAggregationModel.deleteMany({ updatedAt: { $lt: cutoffDate } });
            common.logInfo(`DBService.cleanTrades: Deleted ${result.deletedCount} old records`);
        } catch (error) {
            common.logError(`DBService.cleanTrades: ${error}`);
            throw error;
        }
    }

    static async cleanBets(ttlMs: number): Promise<void> {
        try {
            const cutoffDate = new Date(Date.now() - ttlMs).toISOString();
            const result = await StakeBetModel.deleteMany({ updatedAt: { $lt: cutoffDate } });
            common.logInfo(`DBService.cleanBets: Deleted ${result.deletedCount} old records`);
        } catch (error) {
            common.logError(`DBService.cleanBets: ${error}`);
            throw error;
        }
    }

    static async addStakeBet(bet: Partial<StakeBetDocument>): Promise<StakeBetDocument> {
        try {
            const newBet = new StakeBetModel(bet);
            await newBet.save();
            return newBet;
        } catch (error) {
            common.logError(`DBService.addStakeBetRecord: Error adding stake bet record: ${error}`);
            throw error;
        }
    }

    static async addStakeBetsBulk(bets: Partial<StakeBetDocument>[]): Promise<boolean> {
        try {
            const bulkOps = bets.map((bet) => ({
                updateOne: {
                    filter: { iid: bet.iid },
                    update: { $setOnInsert: bet },
                    upsert: true,
                    setDefaultsOnInsert: true
                }
            }));

            const result = await StakeBetModel.bulkWrite(bulkOps, { ordered: false });
            return result.ok === 1;
        } catch (error) {
            common.logError(`DBService.addStakeBetsBulk: Error adding stake bet records batch: ${error}`);
            throw error;
        }
    }

    static async markStakeBetAlerted(id: string): Promise<void> {
        try {
            await StakeBetModel.updateOne(
                { _id: new mongoose.Types.ObjectId(id) },
                {
                    $set: {
                        lastAlertedAt: Date.now()
                    }
                }
            );
        } catch (error) {
            common.logError(
                `DBService.markStakeBetAlerted: Error marking alerted status for stake bet with id ${id}: ${error}`
            );
            throw error;
        }
    }

    static async getStakeBetsToAlert(threshold: number, ageMs: number): Promise<StakeBetRecord[]> {
        try {
            const docs = await StakeBetModel.find(
                {
                    amountUSD: { $gte: threshold },
                    createdAt: { $gte: new Date(Date.now() - ageMs) },
                    $or: [{ lastAlertedAt: { $exists: false } }, { lastAlertedAt: null }]
                },
                {
                    iid: 1,
                    type: 1,
                    potentialMultiplier: 1,
                    amountUSD: 1,
                    outcomes: 1,
                    lastAlertedAt: 1
                }
            )
                .lean()
                .exec();

            return docs.map((doc) => ({
                id: String(doc._id),
                iid: doc.iid,
                type: doc.type,
                potentialMultiplier: doc.potentialMultiplier,
                amountUSD: doc.amountUSD,
                outcomes: doc.outcomes,
                lastAlertedAt: doc.lastAlertedAt
            }));
        } catch (error) {
            common.logError(`DBService.getStakeBetsToAlert: ${error}`);
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
