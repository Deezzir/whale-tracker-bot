import { Runner } from './runner';

export abstract class Analyzer extends Runner {
    protected analyzeTask?: Promise<void>;
}
