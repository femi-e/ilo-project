#!/usr/bin/env python3
"""
Style validator: scan text for passive voice, hedging, stacked -ing forms.

Reads text from stdin and outputs a diagnostic report.
Usage: echo "your text here" | python3 check-style.py
       cat document.txt | python3 check-style.py
"""

import re
import sys


def find_passive(text):
    """
    Find passive voice constructions.
    Pattern: form of "be" + past participle (optional adverb between).
    """
    passive_pattern = re.compile(
        r'\b(am|is|are|was|were|been|being)\s+'
        r'(\w+ly\s+)?'  # optional adverb
        r'(\w+ed|brought|built|bought|caught|chosen|dealt|done|drawn|driven|'
        r'fallen|felt|found|given|gone|grown|held|kept|known|laid|led|left|'
        r'lost|made|meant|met|paid|put|read|rent|run|said|seen|sent|set|'
        r'shown|sold|spoken|spent|stood|struck|taken|taught|thought|told|'
        r'understood|worn|written|won)\b',
        re.IGNORECASE
    )
    matches = passive_pattern.findall(text)
    return [m[0] + " " + m[2] for m in matches]


def find_hedging(text):
    """Find hedging words: might, could, may, possibly, perhaps, maybe."""
    hedge_pattern = re.compile(
        r'\b(might|could|may|possibly|perhaps|maybe)\b',
        re.IGNORECASE
    )
    return hedge_pattern.findall(text)


def find_stacked_ing(text):
    """Find stacked -ing forms (more than one -ing word in 10-word window)."""
    sentences = re.split(r'[.!?]+', text)
    issues = []
    for sent in sentences:
        ing_words = re.findall(r'\b\w+ing\b', sent)
        if len(ing_words) >= 2:
            issues.append((sent.strip()[:80], len(ing_words), ing_words))
    return issues


def find_elegant_variation_terms(text):
    """Look for potential term-switching: suggest common synonyms."""
    # This is a heuristic — checks if multiple terms for likely-same-concept appear
    term_groups = [
        (r'\b(utilize|utilisation)\b', r'\b(use|using)\b'),
        (r'\b(commence|commenced)\b', r'\b(start|begin)\b'),
        (r'\b(terminate|terminated)\b', r'\b(end|stop|finish)\b'),
        (r'\b(prior to|subsequent to)\b', r'\b(before|after)\b'),
    ]
    suggestions = []
    for fancy, plain in term_groups:
        fancy_matches = re.findall(fancy, text, re.IGNORECASE)
        if fancy_matches:
            # plain is a regex pattern string, not a compiled regex
            suggestions.append((str(fancy_matches[0]), str(plain)))
    return suggestions


def sentence_lengths(text):
    """Return list of (sentence, word_count) pairs."""
    sentences = re.split(r'[.!?]+', text)
    lengths = []
    for s in sentences:
        words = s.strip().split()
        if len(words) > 0:
            lengths.append((s.strip()[:60], len(words)))
    return lengths


def main():
    text = sys.stdin.read().strip()

    if not text:
        print("No input text.")
        sys.exit(1)

    word_count = len(text.split())
    print(f"📄 Word count: {word_count}\n")

    # Passive voice
    passive = find_passive(text)
    if passive:
        print(f"🔴 Passive voice: {len(passive)} instance(s)")
        for p in passive[:10]:
            print(f"   → \"...{p}...\"")
        if len(passive) > 10:
            print(f"   ... and {len(passive) - 10} more")
    else:
        print("✅ No passive voice detected")

    # Hedging
    hedging = find_hedging(text)
    if hedging:
        print(f"\n🟡 Hedging: {len(hedging)} instance(s)")
        # Count by word
        from collections import Counter
        hedge_counts = Counter(w.lower() for w in hedging)
        for word, count in hedge_counts.most_common():
            print(f"   \"{word}\": {count}x")
    else:
        print("\n✅ Clean on hedging")

    # Stacked -ing
    stacked = find_stacked_ing(text)
    if stacked:
        print(f"\n🟡 Stacked -ing forms: {len(stacked)} sentence(s)")
        for sent, count, words in stacked[:5]:
            print(f"   \"{sent}...\" ({count}: {', '.join(words)})")
    else:
        print("\n✅ No stacked -ing forms")

    # Fancy terms
    fancy = find_elegant_variation_terms(text)
    if fancy:
        print(f"\n🟡 Fancy terms detected: {len(fancy)}")
        for term, replacement in fancy:
            print(f'   "{term}" → prefer {replacement}')

    # Sentence lengths
    lengths = sentence_lengths(text)
    if lengths:
        avg_len = sum(l[1] for l in lengths) / len(lengths)
        long_sentences = [l for l in lengths if l[1] > 30]
        print(f"\n📏 Avg sentence length: {avg_len:.0f} words")
        if long_sentences:
            print(f"   ⚠️  {len(long_sentences)} sentence(s) over 30 words:")
            for s, wc in long_sentences[:3]:
                print(f"      → {wc} words: \"{s}...\"")

    print("\n---")
    if not passive and not hedging and not stacked and not fancy:
        print("✅ Style looks clean. Good to go.")
    else:
        print("💡 Review flagged items above. Re-run after fixing.")


if __name__ == "__main__":
    main()