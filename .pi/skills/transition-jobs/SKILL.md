---
name: transition-jobs
description: Searches and ranks office-based roles for bartending-to-corporate career transitions in London. Covers analyst, coordinator, and entry-level office roles. Use when looking for jobs to transition from hospitality into corporate or office-based work.
keywords: ["jobs", "search", "analyst", "coordinator", "london", "transition"]
topic: Job Search — Hospitality to Office Transition
---

# Transition Jobs

Searches UK job platforms for roles that bridge bartending/hospitality experience into office-based careers in London. Covers analyst, coordinator, and entry-level corporate roles.

## Usage

Call this skill when the user asks to find jobs or roles for their career transition. Construct 6–10 searches covering the role priority tiers and search techniques below.

## Role Priority Tiers

Rank results using these tiers. A Tier 1 match should outrank any Tier 2 or Tier 3 result.

| Tier | Roles | Why |
| ------ | ------- | ----- |
| **Tier 1** | Data analyst, junior data analyst, BI analyst, reporting analyst, insights analyst | Closest to the target career |
| **Tier 2** | Operations coordinator, project coordinator, logistics coordinator, office coordinator, account coordinator | Entry point into corporate, uses ops/logistics skills from bartending |
| **Tier 3** | Administrator, operations assistant, client services, junior project manager, supply chain assistant | Broader office entry roles with transferable overlap |

## Query Construction Pattern

Do not run a fixed list. Generate searches dynamically using these techniques.

### 1. Site: Searches for ATS Platforms (highest reliability)

Target the ATS platforms that hospitality-adjacent and corporate companies use:

```
site:jobs.workable.com "<tier 1 title>" London
site:job-boards.greenhouse.io "<tier 1 title>" London
site:jobs.lever.co "<tier 2 title>" London
site:jobs.ashbyhq.com "<tier 1 title>" London
site:myworkdayjobs.com "<tier 2 title>" London
```

Generate at least one ATS search per tier. Example concrete searches are in [references/boolean-strings.md](references/boolean-strings.md).

### 2. Boolean LinkedIn Searches

Combine role titles with transferable-skills keywords:

```
"<tier 1 title>" AND ("hospitality" OR "restaurant" OR "hotel") AND London
"<tier 2 title>" AND London
```

Use `OR` for multiple titles in one search:

```
("data analyst" OR "junior data analyst" OR "BI analyst") AND ("SQL" OR "Python" OR "Tableau") AND London
```

### 3. Job Board Searches

Use `site:reed.co.uk`, `site:totaljobs.com`, `site:cv-library.co.uk` with title + location:

```
site:reed.co.uk "<title>" London
```

### 4. Hospitality-Transition Boards

Search boards where hospitality experience is seen as an advantage:

```
site:caterer.com "<title>" OR "analyst" OR "coordinator" London
site:leisurejobs.com "analyst" OR "coordinator" OR "administrator"
```

### Choosing Which Searches to Run

- Always run at least 2 Tier 1 searches and 1 Tier 2 search
- If the user mentions a specific industry (hotels, restaurants, events), add searches targeting that industry
- If results are sparse, broaden titles (drop "junior", use "analyst" alone, add "assistant" variants)
- Prioritise ATS platform searches — they return live, verified listings

## Output Format

Return results in this table. See [assets/output-template.md](assets/output-template.md) for the exact format.

## Ranking Criteria

Rank the top 10 by:

1. **Tier** — Tier 1 first, then Tier 2, then Tier 3
2. **Transferable skill match** — Roles that explicitly mention hospitality, operations, logistics, or client-facing experience
3. **Salary** — £25K–£45K realistic range for transition. Flag below £25K as "low"
4. **Location** — London first, then hybrid, then remote
5. **Freshness** — Posted within the last 2 weeks. Flag 🔥 for within 48 hours

## Gotchas

- Career sites (Caterer, LeisureJobs) may return CAPTCHAs or 403s. Skip and note it if blocked.
- LinkedIn site: search is rate-limited. Use boolean LinkedIn searches as a fallback.
- Many coordinator roles don't list salary. Mark as "unlisted" rather than filtering out.
- Some job boards interpret "coordinator" broadly (event coordinator, wedding coordinator). These are not corporate office roles — skip unless they explicitly mention operations/project/logistics.
- ATS platforms (Workable, Greenhouse, Lever, Ashby) are the most reliable source. Run them first.
- Hospitality-transition roles often use different titles ("F&B analyst", "hospitality operations coordinator"). Include these variants when searching hospitality boards.

## Validation

After collecting results, run `scripts/validate-results.py` on the output table. It will deduplicate, filter locations, and flag 🔥 postings. Review the script's report and fix any issues it flags.

Then manually check:

1. Are the top results actually Tier 1 roles?
2. Are any roles outside London that weren't flagged?
3. If fewer than 5 quality results remain, re-run with broader terms.

## Reference

- [references/boolean-strings.md](references/boolean-strings.md) — Example queries per role type and ATS platform
- [assets/output-template.md](assets/output-template.md) — Exact output table template
- [scripts/validate-results.py](scripts/validate-results.py) — Dedup, filter, and flagging script
