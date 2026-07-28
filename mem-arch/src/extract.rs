//! Entity extraction heuristic — generalised around graph link types.
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtractedEntity {
    pub name: String,
    pub start: usize,
    pub end: usize,
    pub confidence: f64,
    pub in_graph: bool,
    pub graph_id: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtractedClaim {
    pub subject: String,
    pub link_type: String,
    pub object: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtractionResult {
    pub text: String,
    pub entities: Vec<ExtractedEntity>,
    pub claims: Vec<ExtractedClaim>,
    pub n_entities: usize,
    pub n_claims: usize,
}

struct Token {
    token: String,
    start: usize,
    end: usize,
}

fn is_stop_word(w: &str) -> bool {
    matches!(
        w,
        "the"
            | "a"
            | "an"
            | "is"
            | "are"
            | "was"
            | "were"
            | "be"
            | "been"
            | "being"
            | "in"
            | "on"
            | "at"
            | "to"
            | "for"
            | "with"
            | "by"
            | "about"
            | "and"
            | "or"
            | "but"
            | "not"
            | "so"
            | "if"
            | "as"
            | "of"
            | "it"
            | "its"
            | "this"
            | "that"
            | "these"
            | "those"
            | "i"
            | "me"
            | "my"
            | "we"
            | "our"
            | "you"
            | "your"
            | "he"
            | "him"
            | "his"
            | "she"
            | "her"
            | "they"
            | "them"
            | "their"
            | "what"
            | "which"
            | "who"
            | "whom"
            | "whose"
            | "why"
            | "how"
            | "tell"
            | "explain"
            | "describe"
            | "show"
            | "list"
            | "find"
            | "give"
            | "name"
            | "define"
            | "does"
            | "did"
            | "will"
            | "would"
            | "could"
            | "should"
            | "can"
            | "may"
            | "might"
            | "shall"
            | "has"
            | "have"
            | "had"
            | "do"
    )
}

fn is_question_word(w: &str) -> bool {
    matches!(
        w,
        "what"
            | "tell"
            | "who"
            | "explain"
            | "how"
            | "why"
            | "when"
            | "where"
            | "show"
            | "list"
            | "describe"
            | "find"
            | "give"
            | "name"
            | "define"
            | "can"
            | "does"
            | "do"
            | "did"
            | "will"
            | "would"
            | "could"
            | "should"
            | "which"
            | "whose"
            | "whom"
    )
}

fn is_common_cap(w: &str) -> bool {
    matches!(
        w,
        "project"
            | "team"
            | "system"
            | "platform"
            | "framework"
            | "language"
            | "tool"
            | "database"
            | "application"
            | "service"
            | "product"
            | "technology"
            | "manager"
            | "director"
            | "lead"
            | "engineer"
            | "monday"
            | "tuesday"
            | "wednesday"
            | "thursday"
            | "friday"
            | "saturday"
            | "sunday"
            | "january"
            | "february"
            | "march"
            | "april"
            | "may"
            | "june"
            | "july"
            | "august"
            | "september"
            | "october"
            | "november"
            | "december"
    )
}

const LINK_PATTERNS: &[(&[&str], &str)] = &[
    (
        &[
            "works on",
            "works at",
            "works for",
            "works with",
            "work on",
            "work at",
            "work for",
            "work with",
            "worked on",
            "worked at",
            "worked for",
            "worked with",
            "working on",
            "working at",
            "working for",
            "working with",
            "manages",
            "managed",
            "managing",
            "leads",
            "led",
            "leading",
            "runs",
            "ran",
            "running",
            "built",
            "builds",
            "building",
            "created",
            "creates",
            "creating",
            "designed",
            "designs",
            "designing",
            "developed",
            "develops",
            "developing",
            "implemented",
            "implements",
            "presents",
            "presented",
            "presenting",
            "teaches",
            "taught",
            "teaching",
            "mentors",
            "mentored",
            "mentoring",
            "collaborates",
            "collaborated",
            "collaborating",
            "collaborates with",
            "collaborated with",
            "collaborating with",
        ],
        "ref",
    ),
    (
        &[
            "reports to",
            "reported to",
            "depends on",
            "depended on",
            "uses",
            "used",
            "using",
            "operates",
            "operated",
        ],
        "dep",
    ),
    (
        &[
            "contains",
            "contained",
            "includes",
            "included",
            "including",
            "part of",
            "belongs to",
        ],
        "con",
    ),
    (
        &[
            "shows",
            "showed",
            "proves",
            "proved",
            "demonstrates",
            "demonstrated",
        ],
        "evidence",
    ),
    (
        &["contradicts", "refutes", "refuted", "disagrees with"],
        "refute",
    ),
];

fn is_punct(c: char) -> bool {
    matches!(
        c,
        '.' | ',' | ';' | ':' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\''
    )
}

fn tokenize(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut byte_cursor = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            byte_cursor += chars[i].len_utf8();
            i += 1;
            continue;
        }
        let start_byte = byte_cursor;
        if is_punct(chars[i]) {
            let c = chars[i];
            tokens.push(Token {
                token: c.to_string(),
                start: start_byte,
                end: start_byte + c.len_utf8(),
            });
            byte_cursor += c.len_utf8();
            i += 1;
            continue;
        }
        while i < chars.len() && !chars[i].is_whitespace() && !is_punct(chars[i]) {
            byte_cursor += chars[i].len_utf8();
            i += 1;
        }
        let end_byte = byte_cursor;
        let word = text[start_byte..end_byte].to_string();
        if let Some(hp) = word.find('-') {
            let (a, b) = word.split_at(hp);
            let b = &b[1..];
            if !a.is_empty()
                && !b.is_empty()
                && a.chars().next().is_some_and(|c| c.is_uppercase())
                && b.chars().next().is_some_and(|c| c.is_uppercase())
            {
                tokens.push(Token {
                    token: a.to_string(),
                    start: start_byte,
                    end: start_byte + hp,
                });
                let hyphen_byte = start_byte + hp;
                tokens.push(Token {
                    token: "-".to_string(),
                    start: hyphen_byte,
                    end: hyphen_byte + 1,
                });
                tokens.push(Token {
                    token: b.to_string(),
                    start: hyphen_byte + 1,
                    end: end_byte,
                });
                continue;
            }
        }
        tokens.push(Token {
            token: word,
            start: start_byte,
            end: end_byte,
        });
    }
    tokens
}

fn gazetteer_find_matches(
    tokens: &[Token],
    text: &str,
    graph: &HashMap<String, (f64, Vec<String>)>,
) -> Vec<ExtractedEntity> {
    let mut matches = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let mut best: Option<(ExtractedEntity, usize)> = None;
        for j in i..tokens.len().min(i + 10) {
            let phrase = text[tokens[i].start..tokens[j].end].to_lowercase();
            if let Some((conf, tags)) = graph.get(&phrase) {
                let ml = j - i + 1;
                if best.as_ref().is_none_or(|b| ml > b.1) {
                    best = Some((
                        ExtractedEntity {
                            name: text[tokens[i].start..tokens[j].end].to_string(),
                            start: tokens[i].start,
                            end: tokens[j].end,
                            confidence: *conf,
                            in_graph: true,
                            graph_id: Some(phrase),
                            tags: tags.clone(),
                        },
                        ml,
                    ));
                }
            }
        }
        if let Some((entity, step)) = best {
            matches.push(entity);
            i += step;
        } else {
            i += 1;
        }
    }
    matches
}

fn pattern_find_candidates(
    tokens: &[Token],
    existing_spans: &HashSet<(usize, usize)>,
    text: &str,
) -> Vec<ExtractedEntity> {
    let mut candidates = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let t = &tokens[i];
        if t.token.is_empty()
            || is_punct(t.token.chars().next().unwrap_or(' '))
            || !t.token.chars().next().is_some_and(|c| c.is_alphabetic())
            || !t.token.chars().next().is_some_and(|c| c.is_uppercase())
        {
            i += 1;
            continue;
        }
        let tl = t.token.to_lowercase();
        if is_stop_word(&tl) || is_question_word(&tl) {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < tokens.len() {
            let nt = &tokens[j];
            if nt.token.is_empty()
                || is_punct(nt.token.chars().next().unwrap_or(' '))
                || !nt.token.chars().next().is_some_and(|c| c.is_alphabetic())
                || !nt.token.chars().next().is_some_and(|c| c.is_uppercase())
            {
                break;
            }
            if is_stop_word(&nt.token.to_lowercase()) || is_question_word(&nt.token.to_lowercase())
            {
                break;
            }
            j += 1;
        }
        if j > i + 1 {
            candidates.push(ExtractedEntity {
                name: text[t.start..tokens[j - 1].end].to_string(),
                start: t.start,
                end: tokens[j - 1].end,
                confidence: 0.35,
                in_graph: false,
                graph_id: None,
                tags: vec![],
            });
            i = j;
        } else {
            if existing_spans.contains(&(t.start, t.end)) {
                i += 1;
                continue;
            }
            let is_acr = t.token.len() >= 2
                && t.token.len() <= 5
                && t.token.chars().all(|c| c.is_uppercase());
            let is_com = is_common_cap(&tl);
            let conf = if is_acr {
                0.35
            } else if is_com {
                0.15
            } else {
                0.30
            };
            candidates.push(ExtractedEntity {
                name: t.token.clone(),
                start: t.start,
                end: t.end,
                confidence: conf,
                in_graph: false,
                graph_id: None,
                tags: vec![],
            });
            i += 1;
        }
    }
    candidates
}

fn claim_extract(text: &str, entities: &[ExtractedEntity]) -> Vec<ExtractedClaim> {
    let mut claims = Vec::new();
    let lower = text.to_lowercase();
    for (i, e1) in entities.iter().enumerate() {
        for e2 in entities.iter().skip(i + 1) {
            if e1.start > e2.start {
                continue;
            }
            let between = &lower[e1.end..e2.start].trim();
            if between.split_whitespace().count() > 5 {
                continue;
            }
            if between.contains(" not ")
                || between.contains("n't ")
                || between.contains(" never ")
                || between.contains(" no ")
            {
                continue;
            }
            for &(patterns, link_type) in LINK_PATTERNS {
                for &pat in patterns {
                    if between.contains(pat) {
                        claims.push(ExtractedClaim {
                            subject: e1.name.clone(),
                            link_type: link_type.to_string(),
                            object: e2.name.clone(),
                            confidence: 0.5,
                        });
                        break;
                    }
                }
            }
        }
    }
    // Single-entity: "Who works at Google?"
    for e in entities {
        let before = &lower[..e.start].trim();
        for &(patterns, link_type) in LINK_PATTERNS {
            for &pat in patterns {
                if before.ends_with(&format!(" {}", pat)) {
                    let words: Vec<&str> = before[..before.len() - pat.len() - 1]
                        .split_whitespace()
                        .collect();
                    if let Some(last) = words.last() {
                        if is_question_word(last) {
                            claims.push(ExtractedClaim {
                                subject: "[implied]".to_string(),
                                link_type: link_type.to_string(),
                                object: e.name.clone(),
                                confidence: 0.4,
                            });
                        }
                    }
                    break;
                }
            }
        }
    }
    // Deduplicate
    let mut seen = HashSet::new();
    claims.retain(|c| seen.insert((c.subject.clone(), c.link_type.clone(), c.object.clone())));
    claims
}

#[deprecated(
    note = "Use the 4B model extraction via analyzeWith4BModel() instead. The heuristic extractor is a low-quality fallback."
)]
pub fn extract(text: &str, graph: &HashMap<String, (f64, Vec<String>)>) -> ExtractionResult {
    if text.trim().is_empty() {
        return ExtractionResult {
            text: text.to_string(),
            entities: vec![],
            claims: vec![],
            n_entities: 0,
            n_claims: 0,
        };
    }
    // Strip non-text symbols (emoji, dingbats, etc.) that can cause
    // byte-boundary panics in lowercasing and string slicing
    let text: String = text
        .chars()
        .filter(|c| {
            c.is_alphabetic()
                || c.is_numeric()
                || c.is_whitespace()
                || matches!(
                    c,
                    '.' | ','
                        | ';'
                        | ':'
                        | '!'
                        | '?'
                        | '('
                        | ')'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                        | '"'
                        | '\''
                        | '-'
                        | '_'
                )
        })
        .collect();
    let tokens = tokenize(&text);
    let g = gazetteer_find_matches(&tokens, &text, graph);
    let g_spans: HashSet<(usize, usize)> = g.iter().map(|e| (e.start, e.end)).collect();
    let p = pattern_find_candidates(&tokens, &g_spans, &text);

    let mut merged: Vec<ExtractedEntity> = g;
    let mut m_spans: HashSet<(usize, usize)> = merged.iter().map(|e| (e.start, e.end)).collect();
    for pc in &p {
        let overlap = m_spans
            .iter()
            .any(|&(s, e)| pc.start < e && pc.end > s && !(pc.start < s && pc.end > e));
        if !overlap {
            m_spans.insert((pc.start, pc.end));
            merged.push(pc.clone());
        }
    }
    merged.sort_by_key(|a| a.start);
    let n_merged = merged.len();

    let claims = claim_extract(&text, &merged);
    let n_clm = claims.len();
    ExtractionResult {
        text: text.to_string(),
        entities: merged,
        claims,
        n_entities: n_merged,
        n_claims: n_clm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_known_entity() {
        let mut graph = HashMap::new();
        graph.insert("ilo".to_string(), (0.85, vec!["project".to_string()]));
        let r = extract("What is ILO?", &graph);
        assert!(r.n_entities >= 1);
        assert!(r.entities.iter().any(|e| e.name == "ILO"));
    }

    #[test]
    fn test_lowercase_entity() {
        let mut graph = HashMap::new();
        graph.insert("ilo".to_string(), (0.85, vec![]));
        let r = extract("Tell me about ilo", &graph);
        assert!(r.n_entities >= 1);
        assert!(r.entities.iter().any(|e| e.name == "ilo"));
    }

    #[test]
    fn test_new_entity() {
        let graph = HashMap::new();
        let r = extract("Sarah manages DataLake", &graph);
        assert!(r.n_entities >= 2);
    }

    #[test]
    fn test_claim() {
        let mut graph = HashMap::new();
        graph.insert("bob".to_string(), (0.7, vec!["person".to_string()]));
        graph.insert("xanadu".to_string(), (0.6, vec!["project".to_string()]));
        let r = extract("Bob manages Xanadu", &graph);
        assert!(r.n_claims >= 1);
    }

    #[test]
    fn test_negation() {
        let mut graph = HashMap::new();
        graph.insert("bob".to_string(), (0.7, vec![]));
        graph.insert("xanadu".to_string(), (0.6, vec![]));
        let r = extract("Bob does not work on Xanadu", &graph);
        assert_eq!(r.n_claims, 0);
    }

    #[test]
    fn test_filter_stop_words() {
        let graph = HashMap::new();
        let r = extract("the and for with", &graph);
        assert_eq!(r.n_entities, 0);
    }

    #[test]
    fn test_empty() {
        let graph = HashMap::new();
        assert_eq!(extract("", &graph).n_entities, 0);
        assert_eq!(extract("   ", &graph).n_entities, 0);
    }
}
