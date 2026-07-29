# Output Template

Return all results in this table format:

| Tier | Role | Company | Location | Salary | Posted | Link | Notes |
| ------ | ------ | --------- | ---------- | -------- | -------- | ------ | ------- |
| 1 | Data Analyst | Company Name | London | £30K-£40K | 2 days ago | [Link](url) | 🔥 Hospitality experience mentioned |
| 2 | Operations Coordinator | Company Name | Hybrid - London | £25K-£30K | 1 week ago | [Link](url) | Good ops transfer |
| 3 | Project Administrator | Company Name | London | Unlisted | 3 days ago | [Link](url) | Check salary |

## Column Rules

| Column | Rule |
| -------- | ------ |
| **Tier** | 1, 2, or 3 from the priority tiers |
| **Role** | Exact job title from the posting |
| **Company** | Company name |
| **Location** | Include "Hybrid" or "Remote" if specified |
| **Salary** | Range from posting, or "Unlisted" |
| **Posted** | Relative time (e.g., "2 days ago") |
| **Link** | Clickable URL |
| **Notes** | 🔥 if posted within 48h. Mention transferable skill overlap |

## Summary Section

After the table, add a summary:

```
**Top 3 Picks:**
1. [Role] at [Company] — [why it's the best fit]
2. [Role] at [Company] — [what makes it strong]
3. [Role] at [Company] — [notable because...]

**Quick Stats:**
- Tier 1 results: [count]
- Tier 2 results: [count]
- Tier 3 results: [count]
- 🔥 Hot (within 48h): [count]
```
