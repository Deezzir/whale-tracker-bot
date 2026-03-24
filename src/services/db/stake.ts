import mongoose, { Document, Schema } from 'mongoose';
import Logger from '../../common/logger';

const logger = new Logger('StakeDB');

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

const StakeBetModel = mongoose.models.StakeBetRecord || mongoose.model<StakeBetDocument>('StakeBet', StakeBetSchema);

export default class StakeDBService {
    static async cleanBets(ttlMs: number): Promise<void> {
        try {
            const cutoffDate = new Date(Date.now() - ttlMs).toISOString();
            const result = await StakeBetModel.deleteMany({ updatedAt: { $lt: cutoffDate } });
            logger.info(`Deleted ${result.deletedCount} old records`);
        } catch (error) {
            logger.error(`${error}`);
            throw error;
        }
    }

    static async addStakeBet(bet: Partial<StakeBetDocument>): Promise<StakeBetDocument> {
        try {
            const newBet = new StakeBetModel(bet);
            await newBet.save();
            return newBet;
        } catch (error) {
            logger.error(`Error adding stake bet record: ${error}`);
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

            const start = performance.now();
            const result = await StakeBetModel.bulkWrite(bulkOps, { ordered: false });
            logger.debug(`addStakeBetsBulk: ${bulkOps.length} ops in ${(performance.now() - start).toFixed(1)}ms`);
            return result.ok === 1;
        } catch (error) {
            logger.error(`Error adding stake bet records batch: ${error}`);
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
            logger.error(`Error marking alerted status for stake bet with id ${id}: ${error}`);
            throw error;
        }
    }

    static async getStakeBetsToAlert(threshold: number, ageMs: number): Promise<StakeBetRecord[]> {
        try {
            const start = performance.now();
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
            logger.debug(`getStakeBetsToAlert: ${docs.length} results in ${(performance.now() - start).toFixed(1)}ms`);

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
            logger.error(`Error retrieving stake bets to alert: ${error}`);
            throw error;
        }
    }
}
