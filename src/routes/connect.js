import express from 'express';
import { ok } from '../utils/respond.js';

const router = express.Router();

// Liveness probe for the frontend's server gate. No failure branch: the old
// catch could only fire on a bug and echoed err.message to the client.
router.get('/api/connect', (req, res) =>
  ok(res, { message: 'Connected.', extra: { timestamp: new Date().toISOString() } }),
);

export default router;
