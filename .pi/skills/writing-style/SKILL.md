---
name: writing-style
description: Applies a personal writing style guide for clear, natural communication. Use when writing documents, responses, messages, or any content that needs to follow a consistent voice.
keywords: ["writing", "style", "prose", "clarity", "communication"]
topic: Writing Style
---

# Writing Style

When this skill is loaded, read the full style guide at `reference.md` and apply it to all writing. The guide covers active voice, sentence structure, word choice, and when to break the rules.

## Quick Reference

### Always Do These

- Make sentences active. The subject does the action.
- Keep most sentences between 15 and 20 words. Vary the length.
- Use the same term for the same thing throughout a document.
- Prefer short words over long ones.
- Put conditions before the actions they affect.
- Build understanding one piece at a time.
- Replace abstract statements with concrete details.
- Explain why something matters, not just what to do.

### Use in Moderation

- Contractions are fine. They make writing sound natural.
- Phrasal verbs are fine. Swap them for single words only if writing for a multilingual audience.
- "-ing" forms are fine. Avoid stacking more than one per sentence.
- Perfect tenses when you need to show sequence. Simple past is usually cleaner.
- Hedging only when you're genuinely uncertain. Skip it for recommendations and facts.
- Semicolons only when two sentences are closely related.

### Rarely Do These

- Sentence fragments only for deliberate emphasis. One per document.
- Em dashes. Restructure the sentence instead.

## Gotchas

- Default habit: the agent tends to overuse hedging ("might", "could", "possibly") even when confident. Override this — skip hedging for recommendations and facts.
- Default habit: the agent tends to write passive voice for technical explanations ("the data was processed"). Convert to active ("we processed the data").
- Default habit: the agent may rename terms for "variety" (switching between "score", "rating", "index"). Pick one term per concept and stick with it.
- Default habit: the agent may front-load abstract summaries before concrete details. Start with the concrete thing, then generalise.

## Validation

Run the style checker after writing and before delivering output:

```bash
echo "<your text>" | python3 scripts/check-style.py
```

Or pipe from a file:

```bash
cat output.txt | python3 scripts/check-style.py
```

The script checks for:

- Passive voice constructions
- Hedging words (might, could, possibly)
- Stacked "-ing" forms
- Fancy vocabulary (utilize → use, commence → start)
- Sentence length outliers

Fix any issues the script flags, then re-run. Manual sanity check after:

1. Does every sentence have an active subject doing the action?
2. Are you using the same term for the same thing throughout?
3. Did you hedge something you're actually certain about?
4. Read the first two sentences aloud — do they flow naturally?

## Reference

For the full style guide with examples and sources, see [reference.md](reference.md).
