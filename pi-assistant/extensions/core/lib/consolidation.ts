// ============================================================================
// lib/consolidation.ts — Stage 2: Merge, prune, and maintain beliefs
// ============================================================================
// Called every 10 turns from events/turn.ts. Three operations:
//   1. Merge similar beliefs (same entity, cosine >0.9 content)
//   2. Prune low-confidence old beliefs (<0.05, last_referenced >30 days)
//   3. Update Config turn_counter
// ============================================================================

import { getDb } from './engine';
// readConfig not needed here — Config reads handled by caller

/**
 * Run consolidation: merge duplicate beliefs, prune low-confidence old ones.
 * Called every 10 turns. Idempotent — safe to call multiple times.
 */
export async function consolidate(): Promise<void> {
  try {
    const db = getDb();
    
    // ── Step 1: Merge similar beliefs (same entity, similar content) ──
    // Find Belief nodes with the same entity and merge those with similar content.
    // We use FTS + content comparison rather than embedding, since embedding
    // might not be available. This catches exact and near-exact duplicates.
    const duplicates = await db.query(
      `MATCH (b1:Belief), (b2:Belief)
       WHERE b1.entity = b2.entity
         AND b1.id < b2.id
         AND b1.content = b2.content
       RETURN b2.id AS id, b1.id AS keepId, b1.confidence AS keepConf, b2.confidence AS delConf`
    );

    for (const dup of duplicates) {
      // Take the higher confidence belief as the survivor
      const keepId = dup.keepConf >= dup.delConf ? dup.keepId : dup.id;
      const delId = dup.keepConf >= dup.delConf ? dup.id : dup.keepId;
      
      // Create CONSOLIDATED_FROM edge
      await db.addEdge('Belief', 'id', keepId, 'Belief', 'id', delId, 'CONSOLIDATED_FROM');
      
      // Delete the duplicate
      await db.exec('MATCH (b:Belief {id: $id}) DETACH DELETE b', { id: delId });
    }

    // ── Step 2: Prune low-confidence old beliefs ──
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    await db.exec(
      'MATCH (b:Belief) WHERE b.confidence < 0.05 AND b.last_referenced < $cutoff DETACH DELETE b',
      { cutoff: thirtyDaysAgo }
    );

    if (duplicates.length > 0) {
      console.log(`[consolidation] Merged ${duplicates.length} duplicate beliefs`);
    }
  } catch (err: any) {
    console.warn('[consolidation] Error:', err.message);
  }
}