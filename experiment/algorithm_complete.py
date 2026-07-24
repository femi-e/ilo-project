#!/usr/bin/env python3
"""Complete ILO algorithm specification with storage schemas and creation rules."""
print("=" * 70)
print("ILO ALGORITHM — Complete Specification")
print("=" * 70)

# ── 1. TURN STORAGE SCHEMA ──
print("""
── 1. TURN STORAGE SCHEMA ──

Each conversational exchange produces ONE Turn node.

Node properties (stored in Prop table):
  Key                 Kind     Example                     Required
  ────────────────────────────────────────────────────────────────────
  session_id          string   "session_20260720"          YES
  turn_index          int      142                         YES
  user_text           string   "What projects does..."    YES
  response_text       string   "Alice works on ILO..."    YES
  model               string   "gpt-4"                     YES
  tokens_in           int      452                         YES
  tokens_out          int      187                         YES
  duration_ms         int      2340                        YES
  
  # Learning loop data (written after response, used for training)
  retrieved_node_ids  string   "p_alice,pr_ilo,t_candle"   OPTIONAL
  used_node_ids       string   "p_alice,pr_ilo"            OPTIONAL
  intent              string   "project"                   OPTIONAL
  user_confirmed      bool     true                        OPTIONAL
  correction_text     string   "Alice also works on Nova"  OPTIONAL

Edges created (LINK table):
  Type    From     To        When
  ──────────────────────────────────────────────────
  ref     Turn     Entity    Turn mentions an entity
  seq     Turn     Turn+1    Temporal ordering
  context View     Turn      View was active during turn

Total per turn: 1 Node + ~5 Props + ~5 LINKs
""")

# ── 2. NODE & EDGE CREATION RULES ──
print("""
── 2. NODE & EDGE CREATION RULES ──

Every node type, when it's created, and what triggers creation:

ENTITY NODE
  Created: First time an entity is mentioned in a query or response
  Trigger: find_seeds() finds no match → LLM extracts new entity name
  Initial:  confidence = 0.7 (low, needs confirmation)
            status = "pending"
            label = extracted name
            subtype = inferred from context (person/project/tool/etc.)

TURN NODE
  Created: Every conversational exchange
  Trigger: After LLM generates response
  Initial:  session_id = current session
            turn_index = session turn count
            All text fields from the exchange

CLAIM NODE
  Created: When LLM states a fact about an entity
  Trigger: Post-processing response text for factual statements
           "Alice works on ILO" → claim about Alice and ILO
  Initial:  confidence = 0.6 (LLM statement, needs verification)
            provenance = "system.extracted"
            type_sub = "fact" (or "inference" / "observation")

VIEW NODE
  Created: Pre-defined by the system
  Trigger: Configuration file or CLI
  Initial:  purpose = description
            entity_filter = list of subtypes
            compiler_level = injection aggressiveness (0-10)

LINK TYPES — When each is created:

  ref (Turn → Entity)
    Created: Every time a turn mentions an entity
    Trigger: Entity appears in user_text or response_text
    Initial weight: 0.7 (strong, explicit mention)
    
  has (Entity → Entity)
    Created: When a relationship is established
    Trigger: User confirms "Alice works on ILO"
             LLM response implies ownership/composition
    Initial weight: 0.6 (default relationship)
    
  dep (Entity → Entity)
    Created: When a dependency is identified
    Trigger: "X depends on Y" in conversation
             Structure: tool depends on language
    Initial weight: 0.5 (neutral dependency)
    
  con (Entity ↔ Entity)
    Created: When two claims contradict
    Trigger: Claim A says "X is true" and Claim B says "X is false"
    Initial weight: 0.4 (contradiction, may be resolvable)
    
  seq (Turn → Turn)
    Created: Every consecutive turn
    Trigger: After turn N is created, link turn N-1 → turn N
    Initial weight: 0.9 (temporal order is highly reliable)
    
  evidence (Claim → Entity)
    Created: When a claim references an entity
    Trigger: Every entity mentioned in claim content gets evidence edge
    Initial weight: matches claim confidence (0.6-0.95)
    
  context (View → Entity)
    Created: When a View is defined
    Trigger: View.entity_filter matches an entity's subtype
    Initial weight: 1.0 (View membership is definitive)

Edge weight dynamics (LEARNING):
  Initial: assigned based on type (0.4-1.0, see above)
  Hebbian: weight increases when co-retrieved and co-used
  Decay:   weight decreases slightly every turn (λ=0.001)
  Oja:     prevents saturation by adding -w² term
  Negative: weight decreases for retrieved-but-unused paths
""")

# ── 3. LEARNING LOOP DATA ──
print("""
── 3. LEARNING LOOP — Data Required ──

The learning loop needs this data every turn:

  INPUT (from retrieval + generation):
    query: str                                    # The user's query
    retrieved_nodes: List[NodeId]                 # What the retrieval returned
    retrieved_scores: List[float]                 # Their scores
    response: str                                 # LLM's generated response
    response_entities: List[Entity]               # Entities mentioned in response
  
  OUTPUT (for Hebbian update):
    used_nodes: List[NodeId]                      # Retrieved AND useful
    unused_nodes: List[NodeId]                    # Retrieved but NOT useful
    co_used_pairs: List[(NodeId, NodeId)]         # Pairs used together
  
  SIGNAL COLLECTION METHODS (choose one or combine):
  
    Method A — Entity Overlap (simplest, no prompt changes):
      used_nodes = retrieved_nodes ∩ entities_in_response
      If a retrieved entity appears in the LLM's response, it was "used"
      
    Method B — Citation Check (requires prompt instruction):
      LLM is instructed to cite node IDs like @alice
      used_nodes = extract @refs from response
      
    Method C — Next-turn Confirmation (most accurate, delayed):
      If next user message confirms → strengthen
      If next user message corrects → weaken
      Uses: user_text of the NEXT turn

  STORED DATA (on the Turn node):
    retrieved_node_ids: for replay/audit
    used_node_ids: for learning loop input
    user_confirmed: for next-turn confirmation signal
  
  CONSOLIDATION TRIGGER:
    Checks every 50 turns (CONSOLIDATION_INTERVAL)
    If hub detected (total incident weight > 5.0):
      Cluster the hub's neighbours
      If cluster is dense (>70% interconnected):
        LLM summarises cluster → new semantic node
        Link original nodes to new node
""")

# ── 4. DYNAMIC CONFIGURATION ──
print("""
── 4. DYNAMIC CONFIGURATION ──

Configuration is not hardcoded. It's stored as View nodes in the graph.

View node properties:
  purpose: str              # "code-review", "research", "planning"
  entity_filter: str        # "person,project,tool" (comma-separated subtypes)
  claim_filter: str         # "fact,observation" (comma-separated type_sub)
  time_window: str          # "24h", "7d", "30d", "all"
  compiler_level: int       # 0-10 injection aggressiveness

  # New: retrieval configuration (stored as View properties)
  max_hops: int             # default: 4
  damping: float            # default: 0.85
  min_score: float          # default: 0.02
  type_penalty: float       # default: 0.3
  context_budget: int       # default: 8000 (chars)
  window_size: int          # default: 15 (turns)
  include_paths: bool       # default: true
  include_turns: bool       # default: true

When no View matches the query: use DEFAULT view with all defaults.
When a View matches: the View's config overrides the defaults.

The user doesn't configure these directly. They create Views.
The algorithm picks the right View based on query intent.
""")

print("=" * 70)
print("SPECIFICATION COMPLETE")
print("=" * 70)
