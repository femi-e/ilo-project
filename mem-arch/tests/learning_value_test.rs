//! Quick analytical test: learning value at project scales.
//! Pure math — no simulation loops, runs in <1ms.

fn weight(retrieved: u32, useful: u32, last_used: u32, turn: u32) -> f64 {
    let freq = (useful as f64 + 1.0) / (retrieved as f64 + 2.0);
    let dt = (turn - last_used) as f64;
    let rec = (-dt * std::f64::consts::LN_2 / 14.0).exp();
    freq * rec
}

#[test]
fn test_learning_value_analytical() {
    // Scenarios: (label, turns, useful_co_occurrences, noise_retrievals)
    let scenarios = [
        ("Tiny: 10 turns,  5 useful,  5× noise", 10u32, 10u32, 50u32),
        ("Demo: 50 turns,  50 useful,  5× noise", 50u32, 50u32, 250u32),
        ("Proj: 100 turns, 100 useful, 5× noise", 100u32, 100u32, 500u32),
        ("Deploy: 500 turns, 500 useful, 5× noise", 500u32, 500u32, 2500u32),
        ("Scale: 1000 turns, 1000 useful, 5× noise", 1000u32, 1000u32, 5000u32),
        // Varying noise levels at scale
        ("Scale: 1000 turns, 1000 useful, 10× noise", 1000u32, 1000u32, 10000u32),
        ("Scale: 1000 turns, 1000 useful, 20× noise", 1000u32, 1000u32, 20000u32),
    ];

    println!("\n{}", "=".repeat(100));
    println!("{:<45} {:>8} {:>8} {:>8} {:>10}",
        "Scenario", "UsefulW", "NoiseW", "Sep", "Budget%");
    println!("{}", "-".repeat(100));

    for &(name, turns, useful_occ, noise_ret) in &scenarios {
        // Useful edge: co-occurred N times, last used this turn
        let w_u = weight(turns.max(useful_occ), useful_occ, turns, turns);
        // Noise edge: retrieved N times, never useful (useful=0), never last used (last_used=0)
        let w_n = weight(noise_ret.max(turns), 0, 0, turns);
        let sep = if w_n > 0.0 { w_u / w_n } else { w_u };
        let noise_frac = w_n / (w_u + w_n + 0.0001) * 100.0;
        let budget_saved = 100.0 - noise_frac;

        println!("{:<45} {:>8.3} {:>8.3} {:>8.1}x {:>9.0}%",
            name, w_u, w_n, sep, budget_saved);
    }

    println!("{}", "=".repeat(100));
    println!("\nInterpretation:");
    println!("  UsefulW = weight of frequently co-used edge (higher = stronger pull)");
    println!("  NoiseW  = weight of irrelevant edge (lower = wasted context)");
    println!("  Sep     = separation ratio (how much PPR prefers useful over noise)");
    println!("  Budget% = context budget NOT wasted on noise entities");
    println!();
    println!("Separation > 5x means PPR will reliably retrieve useful entities first.");
    println!("Budget > 80% means the context block is mostly signal.");
    println!();

    // Assertions
    let w_u_10 = weight(10, 10, 10, 10);
    let w_n_10 = weight(50, 0, 0, 10);
    assert!(w_u_10 / w_n_10 > 3.0, "Should show separation even at 10 turns");

    let w_u_100 = weight(100, 100, 100, 100);
    let w_n_100 = weight(500, 0, 0, 100);
    assert!(w_u_100 / w_n_100 > 10.0, "Should show strong separation at 100 turns");

    let w_u_1000 = weight(1000, 1000, 1000, 1000);
    let w_n_1000 = weight(5000, 0, 0, 1000);
    assert!(w_u_1000 / w_n_1000 > 50.0, "Should show extreme separation at 1000 turns");
}

fn recency(dt_ms: f64, half_life_ms: f64) -> f64 {
    (-dt_ms * std::f64::consts::LN_2 / half_life_ms).exp()
}

#[test]
fn test_half_life_scale_comparison() {
    let candidates = [
        ("1 day      ", 86_400_000.0),
        ("7 days     ", 86_400_000.0 * 7.0),
        ("14 days    ", 86_400_000.0 * 14.0),
        ("30 days    ", 86_400_000.0 * 30.0),
        ("90 days    ", 86_400_000.0 * 90.0),
        ("180 days   ", 86_400_000.0 * 180.0),
        ("365 days   ", 86_400_000.0 * 365.0),
        ("no decay   ", f64::INFINITY),
    ];

    let time_points = [
        ("1 hour ", 3_600_000.0),
        ("1 day  ", 86_400_000.0),
        ("1 week ", 86_400_000.0 * 7.0),
        ("1 month", 86_400_000.0 * 30.0),
        ("3 months", 86_400_000.0 * 90.0),
        ("6 months", 86_400_000.0 * 180.0),
        ("1 year ", 86_400_000.0 * 365.0),
    ];

    println!("\n{}", "=".repeat(100));
    println!("Half-life scale comparison — recency factor exp(-dt × ln2 / half_life)");
    println!("A frequently-used link (10/10 useful, freq=0.92) × recency = effective weight");
    println!("{}", "=".repeat(100));
    
    let freq_high = (10.0 + 1.0) / (10.0 + 2.0); // 0.92
    
    // Header
    print!("{:<12}", "");
    for &(name, _) in &candidates {
        print!(" {:<12}", name);
    }
    println!();
    println!("{}", "-".repeat(100));

    for &(t_label, t_ms) in &time_points {
        print!("{:<12}", t_label);
        for &(_, hl) in &candidates {
            let r = if hl.is_infinite() { 1.0 } else { recency(t_ms, hl) };
            let w = freq_high * r;
            print!(" {:<12.4}", w);
        }
        println!();
    }

    println!("\nRecall interpretation (what 0.50+ means):");
    println!("  0.90+ = near-perfect recall   0.70–0.90 = strong recall");
    println!("  0.50–0.70 = usable memory     0.30–0.50 = fuzzy");
    println!("  0.10–0.30 = faint trace       0.00–0.10 = forgotten");

    // Print raw recency too for clarity
    println!("\nRaw recency factor (without frequency):");
    println!("{}", "-".repeat(100));
    print!("{:<12}", "");
    for &(name, _) in &candidates {
        print!(" {:<12}", name);
    }
    println!();
    println!("{}", "-".repeat(100));
    for &(t_label, t_ms) in &time_points {
        print!("{:<12}", t_label);
        for &(_, hl) in &candidates {
            let r = if hl.is_infinite() { 1.0 } else { recency(t_ms, hl) };
            print!(" {:<12.4}", r);
        }
        println!();
    }
    println!();
}
