---
name: dajobsearch
description: Searches for data analyst job listings in London across multiple job boards. Filters by hospitality, £30K+ salary, and recent postings. Use when the user wants to find new data analyst roles to apply for.
keywords: ["jobs", "search", "analyst", "london", "hospitality"]
---

# Data Analyst Job Search

Searches multiple UK job platforms for data analyst roles in London, prioritising hospitality, retail, and entry-level positions.

## Usage

Call this skill when the user asks to find new data analyst roles. Run the searches below in sequence.

## Search Queries to Run

### 1. Reed.co.uk

```
site:reed.co.uk "data analyst" OR "junior data analyst" London £30000
```

### 2. TotalJobs

```
site:totaljobs.com "data analyst" OR "junior data analyst" London
```

### 3. Caterer.com (Hospitality specific)

```
site:caterer.com "data analyst" OR "analyst" London
```

### 4. LeisureJobs (Hospitality specific)

```
site:leisurejobs.com "data analyst" OR "analyst" London
```

### 5. LinkedIn Jobs

```
site:linkedin.com/jobs "data analyst" London hospitality
```

### 6. CV-Library

```
site:cv-library.co.uk "data analyst" London
```

### 7. Google X-Ray — ATS Platforms

```
site:jobs.workable.com "data analyst" London
site:job-boards.greenhouse.io "data analyst" London
site:jobs.lever.co "data analyst" London
site:jobs.ashbyhq.com "data analyst" London
```

### 8. Boolean Search (LinkedIn)

```
"data analyst" AND hospitality AND London
"junior data analyst" AND London
"data analyst" AND (hotel OR restaurant OR hospitality) AND London
```

## Output Format

For each role found, return:

| Role | Company | Location | £ Range | Posted | Link |
|---|---|---|---|---|---|
| [title] | [company] | [area] | [salary] | [date] | [url] |

Then rank the top 5 by:

1. Hospitality relevance (domain match)
2. Freshness (recently posted)
3. Salary (within £30K-£50K range)
4. Location (London / hybrid)

## Gotchas

- Career sites (Caterer, LeisureJobs) may return CAPTCHAs or 403s to automated searches. If a site blocks, skip it and note it in the output.
- LinkedIn site: search is rate-limited and may return truncated results. Use the boolean searches instead when possible.
- Some job boards don't show salary in search snippets. For those roles, mark the £ range as "unlisted" rather than assuming below £30K.
- ATS platform searches (Workable, Greenhouse, Lever, Ashby) are more reliable than general job boards — prioritise them.

## Validation

After collecting results, run a self-check:

1. Deduplicate — remove rows where the same role and company appear from different boards (keep the freshest posting).
2. Check each role's location — remove any outside London unless explicitly hybrid or remote.
3. Flag any roles posted within the last 48 hours as 🔥.
4. If fewer than 5 results remain, re-run with broader terms (drop "hospitality" filter, expand to "analyst" without "data").

## Notes

- Use `recencyFilter: "week"` on searches to get fresh results
- Filter out roles below £30K
- Filter out roles outside London unless hybrid/remote
- Prioritise hospitality, food, retail, and hotel industry roles

## Reference

Full boolean search strings and career site list: [references/boolean-strings.md](references/boolean-strings.md)
