// Where the agent keeps what it saw and what it proposed.

import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "../server/db.ts";
import type { Check, Claim, Decision } from "../shared/types.ts";

export interface SnapshotInput {
  mandateId: string;
  /** The demo shop the page belongs to, or null if it is not one of ours. */
  shopId: string | null;
  url: string;
  title: string;
  text: string;
  fetchedAt: Date;
}

export interface ProposalRecord {
  id: string;
  mandateId: string;
  snapshotId: string;
  shopId: string;
  itemKey: string;
  category: string;
  totalCents: number;
  deliveryBy: string | null;
  claims: Claim[];
  sellerScore: number | null;
  reasoning: string;
  decision: Decision;
  checks: Check[];
  /** The agent run that made it, so a shortlist can be shown together. */
  runId?: string;
}

export interface AgentStore {
  saveSnapshot(s: SnapshotInput): Promise<string>;
  saveProposal(p: ProposalRecord): Promise<void>;
}

export const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");

/** For tests: keeps everything in memory. */
export function memoryStore(): AgentStore & { snapshots: Map<string, SnapshotInput>; proposals: ProposalRecord[] } {
  const snapshots = new Map<string, SnapshotInput>();
  const proposals: ProposalRecord[] = [];
  return {
    snapshots,
    proposals,
    async saveSnapshot(s) {
      const id = randomUUID();
      snapshots.set(id, s);
      return id;
    },
    async saveProposal(p) {
      proposals.push(p);
    },
  };
}

export function dbStore(pool: Pool): AgentStore {
  return {
    async saveSnapshot(s) {
      const res = await pool.query<{ id: string }>(
        "insert into snapshots (mandate_id, shop_id, url, title, text, fingerprint, fetched_at) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [s.mandateId, s.shopId, s.url, s.title, s.text, fingerprint(s.text), s.fetchedAt],
      );
      return res.rows[0]!.id;
    },
    async saveProposal(p) {
      await pool.query(
        `insert into proposals (id, mandate_id, snapshot_id, shop_id, item_key, category, total_cents, delivery_by, claims, seller_score, reasoning, decision, checks, run_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [p.id, p.mandateId, p.snapshotId, p.shopId, p.itemKey, p.category, p.totalCents, p.deliveryBy, JSON.stringify(p.claims), p.sellerScore, p.reasoning, p.decision, JSON.stringify(p.checks), p.runId ?? null],
      );
    },
  };
}
