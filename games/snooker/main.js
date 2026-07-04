// 斯诺克 — thin wrapper: the snooker ruleset on the shared pool-common engine.
import { rules } from './rules.js';
import { startPool } from '../pool-common/app.js';

startPool(rules);
