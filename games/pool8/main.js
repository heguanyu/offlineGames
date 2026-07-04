// 黑八台球 — thin wrapper: the 8-ball ruleset on the shared pool-common engine.
import { rules } from './rules.js';
import { startPool } from '../pool-common/app.js';

startPool(rules);
