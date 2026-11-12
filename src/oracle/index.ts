// Package oracle: decides whether a run broke the scenario's rules.
export { checkInvariants, type InvariantResult } from './oracle.ts';
export { SerialOracle, serialOrders, snapshot, type Outcome } from './serial.ts';
