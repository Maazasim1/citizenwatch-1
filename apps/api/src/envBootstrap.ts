/**
 * Load apps/api/.env before any other module reads process.env (import hoisting safe).
 */
import path from 'path';
import { config } from 'dotenv';

config({ path: path.resolve(__dirname, '../.env') });
