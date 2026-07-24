// ============================================================================
// ILO Test Harness v2 — Full retrieval path validation
// Tests: single/multi seed, spreading activation, temporal decay,
//   inhibition, context assembly, view filters, scalability.
// Pure std-only Rust.
// Run:  cargo run  (from ilo/test-harness/)
// ============================================================================

use std::collections::{HashMap, HashSet};

type NodeId = String;

#[derive(Debug, Clone)]
struct Node { id: NodeId, label: String, confidence: f64, created_at: u64 }

#[derive(Debug, Clone)]
struct Link {
    id: String, from: NodeId, to: NodeId, weight: f64,
    turn_time: u64, link_type: String,
}

#[derive(Debug, Clone)]
struct Activated {
    node_id: NodeId, activation: f64, depth: u8, path: Vec<String>,
    source_seed: String,
}

// ════════════════════════════════════════════════════════════════════════════
// FAKE GRAPH
// ════════════════════════════════════════════════════════════════════════════

struct FakeGraph {
    nodes: HashMap<NodeId, Node>,
    links: HashMap<String, Link>,
    out_idx: HashMap<NodeId, Vec<String>>,
    in_idx: HashMap<NodeId, Vec<String>>,
}

impl FakeGraph {
    fn new() -> Self {
        FakeGraph {
            nodes: HashMap::new(), links: HashMap::new(),
            out_idx: HashMap::new(), in_idx: HashMap::new(),
        }
    }
    fn add(&mut self, node: Node) { self.nodes.insert(node.id.clone(), node); }
    fn connect(&mut self, from: &str, to: &str, weight: f64, turn_time: u64, ltype: &str) {
        let id = format!("{}-{}", from, to);
        self.out_idx.entry(from.into()).or_default().push(id.clone());
        self.in_idx.entry(to.into()).or_default().push(id.clone());
        self.links.insert(id.clone(), Link {
            id, from: from.into(), to: to.into(), weight, turn_time, link_type: ltype.into(),
        });
    }
    fn get(&self, id: &str) -> Option<&Node> { self.nodes.get(id) }
    fn incident(&self, nid: &str) -> Vec<&Link> {
        let mut e = Vec::new();
        if let Some(ids) = self.out_idx.get(nid) {
            for id in ids { if let Some(l) = self.links.get(id) { e.push(l); } }
        }
        if let Some(ids) = self.in_idx.get(nid) {
            for id in ids { if let Some(l) = self.links.get(id) { if l.from != l.to { e.push(l); } } }
        }
        e
    }
    fn find_link_mut(&mut self, a: &str, b: &str) -> Option<&mut Link> {
        let f = format!("{}-{}", a, b);
        let r = format!("{}-{}", b, a);
        if self.links.contains_key(&f) { self.links.get_mut(&f) }
        else { self.links.get_mut(&r) }
    }
    fn random(num_nodes: usize, edges_per_node: usize) -> Self {
        let mut g = FakeGraph::new();
        let words = ["alice","bob","carol","dave","eve","project","task","bug","feature",
            "meeting","doc","code","review","deploy","test","api","ui","auth","cache",
            "query","index","schema","migration","backup","monitor","alert","dashboard"];
        for i in 0..num_nodes {
            let label = words[i % words.len()];
            let conf = 0.5 + ((i * 7) % 50) as f64 / 100.0;
            g.add(Node {
                id: format!("n{}", i), label: format!("{}_{}", label, i),
                confidence: conf.min(0.99), created_at: i as u64 * 10,
            });
        }
        for i in 0..num_nodes {
            for _ in 0..edges_per_node {
                let j = (i + 1 + (i * 13 + 7) % num_nodes) % num_nodes;
                if i != j {
                    let w = 0.2 + ((i + j) % 80) as f64 / 100.0;
                    g.connect(&format!("n{}", i), &format!("n{}", j), w.min(0.99),
                        (i + j) as u64 * 5, "ref");
                }
            }
        }
        g
    }
    fn node_count(&self) -> usize { self.nodes.len() }
    fn link_count(&self) -> usize { self.links.len() }
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const ACT_THRESHOLD: f64 = 0.005;
const BACKWARD_DISCOUNT: f64 = 0.5;
const NOW: u64 = 10000;

// ════════════════════════════════════════════════════════════════════════════
// SPREADING ACTIVATION
// ════════════════════════════════════════════════════════════════════════════

fn spread_activation(
    graph: &FakeGraph, seeds: &[(String, f64)], max_hops: u8,
    inhibit_m: usize, inhibit_beta: f64, depth_protect: bool,
    temporal: bool, verbose: bool,
) -> Vec<Activated> {
    let mut activation: HashMap<NodeId, f64> = HashMap::new();
    let mut depths: HashMap<NodeId, u8> = HashMap::new();
    let mut paths: HashMap<NodeId, Vec<String>> = HashMap::new();
    let mut seed_src: HashMap<NodeId, String> = HashMap::new();

    for (seed_id, seed_conf) in seeds {
        if let Some(n) = graph.get(seed_id) {
            let energy = n.confidence * seed_conf;
            *activation.entry(seed_id.clone()).or_insert(0.0) += energy;
            depths.insert(seed_id.clone(), 0);
            paths.insert(seed_id.clone(), vec![seed_id.clone()]);
            seed_src.insert(seed_id.clone(), seed_id.clone());
            if verbose {
                println!("  [SEED] '{}' energy={:.4}", seed_id, energy);
            }
        }
    }

    for hop in 1..=max_hops {
        if verbose && hop == 1 { println!(); }
        let mut next: HashMap<NodeId, f64> = HashMap::new();
        let mut next_depth: HashMap<NodeId, u8> = HashMap::new();
        let mut next_path: HashMap<NodeId, Vec<String>> = HashMap::new();
        let mut next_src: HashMap<NodeId, String> = HashMap::new();

        for (nid, energy) in &activation {
            if *energy < ACT_THRESHOLD { continue; }
            let edges = graph.incident(nid);
            if edges.is_empty() { continue; }
            for link in &edges {
                let is_fwd = link.from == *nid;
                let target = if is_fwd { &link.to } else { &link.from };
                if *target == *nid { continue; }
                let discount = if is_fwd { 1.0 } else { BACKWARD_DISCOUNT };
                let temporal_factor = if temporal {
                    let age = NOW.saturating_sub(link.turn_time);
                    1.0 / (1.0 + age as f64 * 0.0001)
                } else { 1.0 };
                let prop = *energy * link.weight * discount * temporal_factor / edges.len() as f64;
                if prop < ACT_THRESHOLD { continue; }
                *next.entry(target.clone()).or_insert(0.0) += prop;
                let cd = depths.get(nid).unwrap_or(&0) + 1;
                if cd < *next_depth.get(target).unwrap_or(&u8::MAX) {
                    next_depth.insert(target.clone(), cd);
                    if let Some(pp) = paths.get(nid) {
                        let mut np = pp.clone(); np.push(target.clone());
                        next_path.insert(target.clone(), np);
                    }
                    next_src.insert(target.clone(), seed_src.get(nid).cloned().unwrap_or_default());
                }
                if verbose {
                    println!("      {}→'{}' w={:.2} t={:.2} = {:.4}", nid, target, link.weight, temporal_factor, prop);
                }
            }
        }

        // Lateral inhibition
        let mut sorted: Vec<(NodeId, f64)> = next.clone().into_iter().collect();
        sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        if sorted.len() > inhibit_m {
            let top_act = sorted[inhibit_m - 1].1;
            for (i, (id, energy)) in sorted.iter().enumerate() {
                if i >= inhibit_m {
                    let d = *next_depth.get(id).unwrap_or(&1);
                    let depth_factor = if depth_protect && d >= 3 { 0.3 } else { 1.0 };
                    let effective_beta = inhibit_beta * depth_factor;
                    let s = (top_act - energy) * effective_beta;
                    next.insert(id.clone(), (*energy - s).max(0.0));
                }
            }
        }

        let active: Vec<_> = next.iter().filter(|(_, e)| **e >= ACT_THRESHOLD).collect();
        if active.is_empty() { break; }
        for (id, e) in &next {
            if *e >= ACT_THRESHOLD {
                activation.insert(id.clone(), *e);
                if let Some(d) = next_depth.get(id) { depths.insert(id.clone(), *d); }
                if let Some(p) = next_path.get(id) { paths.insert(id.clone(), p.clone()); }
                if let Some(s) = next_src.get(id) { seed_src.insert(id.clone(), s.clone()); }
            }
        }
    }

    let mut result: Vec<Activated> = activation.into_iter()
        .map(|(id, act)| Activated {
            node_id: id.clone(), activation: act,
            depth: depths.get(&id).copied().unwrap_or(0),
            path: paths.get(&id).cloned().unwrap_or_default(),
            source_seed: seed_src.get(&id).cloned().unwrap_or_default(),
        }).collect();
    result.sort_by(|a, b| b.activation.partial_cmp(&a.activation).unwrap());
    result
}

// ════════════════════════════════════════════════════════════════════════════
// SEED FINDING
// ════════════════════════════════════════════════════════════════════════════

fn find_seeds(query: &str, graph: &FakeGraph) -> Vec<(String, f64)> {
    let q = query.to_lowercase();
    let mut seeds = Vec::new();
    for node in graph.nodes.values() {
        let lbl = node.label.to_lowercase();
        if lbl == q { seeds.push((node.id.clone(), 1.0)); continue; }
        if lbl.contains(&q) || q.contains(&lbl) { seeds.push((node.id.clone(), 0.7)); }
    }
    let mut deduped: HashMap<String, f64> = HashMap::new();
    for (id, score) in seeds { let e = deduped.entry(id).or_insert(0.0); *e = (*e).max(score); }
    let mut result: Vec<(String, f64)> = deduped.into_iter().collect();
    result.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    result.truncate(5);
    result
}

fn extract_and_find_seeds(query: &str, graph: &FakeGraph) -> Vec<(String, f64)> {
    let mut all = Vec::new();
    for word in query.split_whitespace() {
        let c: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
        if c.len() > 1 { all.extend(find_seeds(&c, graph)); }
    }
    let mut deduped: HashMap<String, f64> = HashMap::new();
    for (id, score) in all { let e = deduped.entry(id).or_insert(0.0); *e = (*e).max(score); }
    let mut result: Vec<(String, f64)> = deduped.into_iter().collect();
    result.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    result.truncate(5);
    result
}

// ════════════════════════════════════════════════════════════════════════════
// CONTEXT ASSEMBLY
// ════════════════════════════════════════════════════════════════════════════

fn assemble_context(activated: &[Activated], graph: &FakeGraph, max_chars: usize) -> String {
    let mut lines = Vec::new();
    lines.push("--- BEGIN RETRIEVED CONTEXT ---".into());
    lines.push(format!("Activated: {} nodes\n", activated.len()));
    for node in activated {
        if let Some(n) = graph.get(&node.node_id) {
            let score = node.activation * n.confidence;
            let indent = "  ".repeat(node.depth as usize);
            let t = if node.source_seed == node.node_id { "SEED" }
                    else if node.node_id.starts_with('t') { "TURN" }
                    else { "ENTITY" };
            lines.push(format!("{}- [{}] {} (score: {:.4})", indent, t, n.label, score));
            if node.path.len() > 1 {
                let ps: Vec<&str> = node.path.iter().map(|id|
                    graph.get(id).map(|n| n.label.as_str()).unwrap_or(id)).collect();
                lines.push(format!("{}  via: {}", indent, ps.join(" → ")));
            }
        }
    }
    lines.push("\n--- END RETRIEVED CONTEXT ---".into());
    let text = lines.join("\n");
    if text.len() > max_chars {
        let mut t = text[..max_chars].to_string();
        t.push_str("\n... [truncated]");
        t
    } else { text }
}

// ════════════════════════════════════════════════════════════════════════════
// HEBBIAN LEARNING
// ════════════════════════════════════════════════════════════════════════════

fn hebbian_update(
    graph: &mut FakeGraph, co_used: &[(String, String)],
    retrieved: &[String], used: &[String], verbose: bool,
) {
    let used_set: HashSet<&str> = used.iter().map(|s| s.as_str()).collect();
    let confs: HashMap<String, f64> = graph.nodes.iter().map(|(k, v)| (k.clone(), v.confidence)).collect();
    for (a, b) in co_used {
        if let Some(link) = graph.find_link_mut(a, b) {
            let w = link.weight;
            let kg = 1.0 - (confs.get(a).copied().unwrap_or(0.5)
                + confs.get(b).copied().unwrap_or(0.5)) / 2.0;
            let delta = 0.1 * (1.0 - w) * kg;
            link.weight = (w + delta).clamp(0.0, 1.0);
            if verbose { println!("    {}↔{}: {:.4}→{:.4} (Δ={:.6})", a, b, w, link.weight, delta); }
        }
    }
    for link in graph.links.values_mut() { link.weight = (link.weight * 0.999).clamp(0.0, 1.0); }
    if verbose { println!("  Decayed {} links", graph.links.len()); }
    for rid in retrieved {
        if used_set.contains(rid.as_str()) { continue; }
        if let Some(ids) = graph.out_idx.get(rid).cloned() {
            for id in &ids {
                if let Some(link) = graph.links.get_mut(id) {
                    let old = link.weight;
                    link.weight = (link.weight * 0.98).clamp(0.0, 1.0);
                    if verbose { println!("  [NEG] {}→{}: {:.4}→{:.4}", link.from, link.to, old, link.weight); }
                }
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST GRAPHS
// ════════════════════════════════════════════════════════════════════════════

fn build_deep() -> FakeGraph {
    let mut g = FakeGraph::new();
    g.add(Node { id: "q".into(), label: "query".into(), confidence: 0.95, created_at: 0 });
    g.add(Node { id: "t1".into(), label: "Turn#1".into(), confidence: 1.0, created_at: 100 });
    g.add(Node { id: "e1".into(), label: "bridge".into(), confidence: 0.85, created_at: 200 });
    g.add(Node { id: "t2".into(), label: "Turn#2".into(), confidence: 1.0, created_at: 300 });
    g.add(Node { id: "ans".into(), label: "answer".into(), confidence: 0.90, created_at: 400 });
    g.add(Node { id: "dist".into(), label: "distractor".into(), confidence: 0.75, created_at: 50 });
    g.connect("q", "t1", 0.6, 100, "ref"); g.connect("t1", "e1", 0.8, 150, "ref");
    g.connect("e1", "t2", 0.7, 250, "ref"); g.connect("t2", "ans", 0.9, 350, "ref");
    g.connect("q", "dist", 0.7, 50, "ref");
    g
}

/// Graph with two competing seeds and paths
fn build_multi_seed() -> FakeGraph {
    let mut g = FakeGraph::new();
    g.add(Node { id: "alice".into(), label: "alice".into(), confidence: 0.95, created_at: 0 });
    g.add(Node { id: "bob".into(), label: "bob".into(), confidence: 0.60, created_at: 0 });
    g.add(Node { id: "turn_a".into(), label: "Turn#Alice".into(), confidence: 1.0, created_at: 100 });
    g.add(Node { id: "turn_b".into(), label: "Turn#Bob".into(), confidence: 0.8, created_at: 200 });
    g.add(Node { id: "project_ilo".into(), label: "ILO".into(), confidence: 0.95, created_at: 50 });
    g.add(Node { id: "project_zephyr".into(), label: "Zephyr".into(), confidence: 0.90, created_at: 60 });
    g.connect("alice", "turn_a", 0.8, 100, "ref");
    g.connect("turn_a", "project_ilo", 0.9, 150, "ref");
    g.connect("bob", "turn_b", 0.7, 200, "ref");
    g.connect("turn_b", "project_zephyr", 0.8, 250, "ref");
    g.connect("project_ilo", "project_zephyr", 0.3, 300, "dep"); // weak cross-link
    g
}

/// Graph with old and new turns for temporal testing
fn build_temporal() -> FakeGraph {
    let mut g = FakeGraph::new();
    g.add(Node { id: "topic".into(), label: "topic".into(), confidence: 0.90, created_at: 0 });
    g.add(Node { id: "old_turn".into(), label: "OldTurn".into(), confidence: 1.0, created_at: 100 });
    g.add(Node { id: "new_turn".into(), label: "NewTurn".into(), confidence: 1.0, created_at: 9500 });
    g.add(Node { id: "old_info".into(), label: "old_info".into(), confidence: 0.70, created_at: 200 });
    g.add(Node { id: "new_info".into(), label: "new_info".into(), confidence: 0.90, created_at: 9600 });
    // Old path: topic → old_turn (age 9900) → old_info
    g.connect("topic", "old_turn", 0.8, 100, "ref");
    g.connect("old_turn", "old_info", 0.7, 200, "ref");
    // New path: topic → new_turn (age 500) → new_info
    g.connect("topic", "new_turn", 0.8, 9500, "ref");
    g.connect("new_turn", "new_info", 0.7, 9600, "ref");
    g
}

/// Graph where two entities share a label but differ in confidence
fn build_disambiguation() -> FakeGraph {
    let mut g = FakeGraph::new();
    g.add(Node { id: "alice_work".into(), label: "alice".into(), confidence: 0.95, created_at: 500 });
    g.add(Node { id: "alice_personal".into(), label: "alice".into(), confidence: 0.30, created_at: 500 });
    g.add(Node { id: "project_ilo".into(), label: "ILO".into(), confidence: 0.95, created_at: 300 });
    g.add(Node { id: "hobby".into(), label: "hiking".into(), confidence: 0.85, created_at: 400 });
    g.connect("alice_work", "project_ilo", 0.9, 600, "ref");
    g.connect("alice_personal", "hobby", 0.7, 500, "ref");
    g
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

/// Test 1: Multi-seed — two seeds activate different paths. Which wins?
fn test_multi_seed() {
    println!("\n══════════ TEST 1: Multi-Seed Propagation ══════════");
    println!("  Query = 'alice bob'. Seeds: alice (conf=0.95), bob (conf=0.60)");
    println!("  alice → ILO, bob → Zephyr. Cross-link: ILO→Zephyr (0.3)\n");
    let g = build_multi_seed();
    let seeds = find_seeds("alice", &g);
    println!("  Found seeds: {:?}", seeds);

    let seeds2 = extract_and_find_seeds("alice bob", &g);
    println!("  From 'alice bob': {:?}", seeds2);
    println!();

    let r = spread_activation(&g, &seeds2, 3, 4, 0.3, true, false, false);
    println!("  Activated:");
    for n in &r { println!("    '{}' ({}) act={:.4} depth={}", n.node_id,
        g.get(&n.node_id).map(|x| x.label.as_str()).unwrap_or("?"),
        n.activation, n.depth); }
    let ilo = r.iter().find(|n| n.node_id == "project_ilo").map(|n| n.activation).unwrap_or(0.0);
    let zephyr = r.iter().find(|n| n.node_id == "project_zephyr").map(|n| n.activation).unwrap_or(0.0);
    println!("\n  ILO={:.4} Zephyr={:.4} ratio={:.2}", ilo, zephyr, ilo / zephyr.max(0.0001));
    if ilo > zephyr { println!("  ✅ Alice (higher confidence) dominates"); }
    else { println!("  ⚠ Both survived"); }
    println!("\n  Context block:\n{}", assemble_context(&r[..3.min(r.len())], &g, 500));
}

/// Test 2: Temporal decay — old vs new turns
fn test_temporal() {
    println!("\n══════════ TEST 2: Temporal Decay ══════════");
    println!("  NOW={}. Old path age≈9900, new path age≈500\n", NOW);
    let g = build_temporal();
    let seeds = vec![("topic".into(), 1.0)];
    let r_old = spread_activation(&g, &seeds, 2, 4, 0.3, true, false, false);
    let r_new = spread_activation(&g, &seeds, 2, 4, 0.3, true, true, false);
    let old_info_no = r_old.iter().find(|n| n.node_id == "old_info").map(|n| n.activation).unwrap_or(0.0);
    let new_info_no = r_old.iter().find(|n| n.node_id == "new_info").map(|n| n.activation).unwrap_or(0.0);
    let old_info_yes = r_new.iter().find(|n| n.node_id == "old_info").map(|n| n.activation).unwrap_or(0.0);
    let new_info_yes = r_new.iter().find(|n| n.node_id == "new_info").map(|n| n.activation).unwrap_or(0.0);
    println!("  Without temporal: old={:.4} new={:.4} (equal)", old_info_no, new_info_no);
    println!("  With temporal:    old={:.4} new={:.4} (new dominates)", old_info_yes, new_info_yes);
    if new_info_yes > old_info_yes { println!("  ✅ Temporal bias works"); }
    else { println!("  ❌ Temporal bias failed"); }
}

/// Test 3: Disambiguation — same label, different confidence
fn test_disambiguation() {
    println!("\n══════════ TEST 3: Disambiguation ══════════");
    println!("  Query 'alice' → two entities with same label (conf 0.95 vs 0.30)\n");
    let g = build_disambiguation();
    let seeds = find_seeds("alice", &g);
    println!("  Seeds found: {:?}", seeds);
    let r = spread_activation(&g, &seeds, 2, 4, 0.3, true, false, false);
    for n in &r { println!("    '{}' ({}) act={:.4}",
        n.node_id, g.get(&n.node_id).map(|x| x.label.as_str()).unwrap_or("?"), n.activation); }
    let work = r.iter().find(|n| n.node_id == "alice_work").map(|n| n.activation).unwrap_or(0.0);
    let personal = r.iter().find(|n| n.node_id == "alice_personal").map(|n| n.activation).unwrap_or(0.0);
    if work > personal { println!("  ✅ High-confidence entity dominates"); }
    else { println!("  ❌ Low-confidence incorrectly won"); }
}

/// Test 4: Context assembly format
fn test_context_format() {
    println!("\n══════════ TEST 4: Context Assembly ══════════");
    let g = build_deep();
    let seeds = vec![("q".into(), 1.0)];
    let r = spread_activation(&g, &seeds, 4, 4, 0.3, true, false, false);
    let ctx = assemble_context(&r, &g, 2000);
    println!("{}", ctx);
    println!("  Context length: {} chars", ctx.len());
    if ctx.len() > 100 { println!("  ✅ Context assembly produces output"); }
}

/// Test 5: Scalability — large random graph
fn test_scalability() {
    println!("\n══════════ TEST 5: Scalability ══════════");
    println!("  Generating random graph...");
    let g = FakeGraph::random(200, 5);
    println!("  Graph: {} nodes, {} links", g.node_count(), g.link_count());
    let seeds = vec![("n0".into(), 1.0), ("n50".into(), 0.8), ("n100".into(), 0.6)];
    let start = std::time::Instant::now();
    let r = spread_activation(&g, &seeds, 4, 5, 0.3, true, false, false);
    let elapsed = start.elapsed();
    println!("  Activated {} nodes in {:?}", r.len(), elapsed);
    println!("  Top 5:");
    for n in &r[..5.min(r.len())] { println!("    '{}' act={:.4} depth={}", n.node_id, n.activation, n.depth); }
    if elapsed.as_millis() < 100 { println!("  ✅ Fast (<100ms)"); }
    else { println!("  ⚠ Slow ({:?})", elapsed); }
}

/// Test 6: Full end-to-end path (seed → propagate → assemble → learn)
fn test_end_to_end() {
    println!("\n══════════ TEST 6: End-to-End Retrieval + Learning ══════════");
    let mut g = build_deep();
    // Phase 1: Retrieve
    let seeds = vec![("q".into(), 1.0)];
    let pre = spread_activation(&g, &seeds, 4, 4, 0.3, true, false, false);
    let pre_ans = pre.iter().find(|n| n.node_id == "ans").map(|n| n.activation).unwrap_or(0.0);
    println!("  Phase 1 — Retrieval: answer={:.4}, context={} chars",
        pre_ans, assemble_context(&pre, &g, 500).len());
    // Phase 2: Learn (q, t1, e1, t2, ans were useful; dist was not)
    let retrieved: Vec<String> = vec!["q".into(),"t1".into(),"e1".into(),"t2".into(),"ans".into(),"dist".into()];
    let used: Vec<String> = vec!["q".into(),"t1".into(),"e1".into(),"t2".into(),"ans".into()];
    let pairs = vec![("q".into(),"t1".into()),("t1".into(),"e1".into()),
                     ("e1".into(),"t2".into()),("t2".into(),"ans".into())];
    println!("  Phase 2 — Learning: strengthening {} pairs", pairs.len());
    hebbian_update(&mut g, &pairs, &retrieved, &used, false);
    // Phase 3: Retrieve again
    let post = spread_activation(&g, &seeds, 4, 4, 0.3, true, false, false);
    let post_ans = post.iter().find(|n| n.node_id == "ans").map(|n| n.activation).unwrap_or(0.0);
    let improvement = if pre_ans > 0.0 { (post_ans - pre_ans) / pre_ans * 100.0 } else { 0.0 };
    println!("  Phase 3 — Re-retrieval: answer={:.4} (improvement={:+.1}%)", post_ans, improvement);
    if improvement > 0.0 { println!("  ✅ System improves with use"); }
    else { println!("  ⚠ No measurable improvement"); }
}

fn main() {
    println!("╔══════════════════════════════════════════════════════╗");
    println!("║   ILO Test Harness v2 — Full Retrieval Path         ║");
    println!("╚══════════════════════════════════════════════════════╝");
    test_multi_seed();
    test_temporal();
    test_disambiguation();
    test_context_format();
    test_scalability();
    test_end_to_end();
    println!("\n══════════ ALL TESTS COMPLETE ══════════");
}
