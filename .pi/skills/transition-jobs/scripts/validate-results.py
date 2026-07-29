#!/usr/bin/env python3
"""
Validate job search results: dedup, filter, and flag.

Reads a markdown table from stdin and outputs a validated version.
Usage: cat results.md | python3 validate-results.py
"""

import re
import sys
from datetime import datetime, timedelta


def parse_table(text):
    """Parse a markdown table into list of dicts."""
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if not lines:
        return []

    # Find the header row
    header_idx = None
    for i, line in enumerate(lines):
        if re.match(r"^\|.*\|.*\|.*\|.*\|.*\|.*\|.*\|$", line):
            header_idx = i
            break

    if header_idx is None:
        return []

    headers = [h.strip() for h in lines[header_idx].split("|")[1:-1]]

    # Skip separator row
    data_start = header_idx + 1
    if data_start < len(lines) and re.match(r"^\|[\s\-:]+\|", lines[data_start]):
        data_start += 1

    rows = []
    for line in lines[data_start:]:
        if not re.match(r"^\|.*\|.*\|.*\|.*\|.*\|.*\|.*\|$", line):
            break
        cells = [c.strip() for c in line.split("|")[1:-1]]
        if len(cells) == len(headers):
            rows.append(dict(zip(headers, cells)))

    return rows


def _extract_number(text: str) -> int:
    """Extract first number from text, default to 1."""
    import re as _re
    m = _re.search(r"(\d+)", text)
    if m is None:
        return 1
    try:
        return int(m.group(1))
    except (ValueError, IndexError):
        return 1


def parse_posted(posted_str):
    """Parse relative time string to a datetime for comparison."""
    posted_str = posted_str.lower().strip()
    now = datetime.now()

    if "hour" in posted_str:
        return now - timedelta(hours=_extract_number(posted_str))
    elif "day" in posted_str:
        return now - timedelta(days=_extract_number(posted_str))
    elif "week" in posted_str:
        return now - timedelta(weeks=_extract_number(posted_str))
    elif "month" in posted_str:
        return now - timedelta(days=_extract_number(posted_str) * 30)
    return now


def deduplicate(rows):
    """Remove duplicate (role + company) combos, keep freshest."""
    seen = {}
    for row in rows:
        key = (row.get("Role", "").lower(), row.get("Company", "").lower())
        if key in seen:
            existing_posted = parse_posted(seen[key].get("Posted", ""))
            new_posted = parse_posted(row.get("Posted", ""))
            if new_posted > existing_posted:
                seen[key] = row
        else:
            seen[key] = row
    return list(seen.values())


def check_location(loc):
    """Return True if location is London, hybrid, or remote."""
    loc_lower = loc.lower()
    if "london" in loc_lower or "hybrid" in loc_lower or "remote" in loc_lower:
        return True
    return False


def check_salary(salary_str):
    """Return min salary if parseable, else None."""
    salary_str = salary_str.lower()
    if "unlisted" in salary_str or "not specified" in salary_str:
        return None
    nums = re.findall(r"£?(\d+),?(\d{3})?", salary_str)
    if nums:
        try:
            return int("".join(nums[0]))
        except ValueError:
            return None
    return None


def is_hot(posted_str):
    """Return True if posted within 48 hours."""
    posted = parse_posted(posted_str)
    return (datetime.now() - posted).total_seconds() < 48 * 3600


def render_table(rows):
    """Render rows back to markdown table."""
    if not rows:
        return "_No results passed validation._"

    headers = list(rows[0].keys())
    sep = "|" + "|".join("---" for _ in headers) + "|"
    header_line = "|" + "|".join(headers) + "|"
    lines = [header_line, sep]

    for row in rows:
        cells = [row.get(h, "") for h in headers]
        lines.append("|" + "|".join(cells) + "|")

    return "\n".join(lines)


def main():
    text = sys.stdin.read()
    rows = parse_table(text)

    if not rows:
        print("⚠️  No table found in input. Paste the output table and re-run.")
        sys.exit(1)

    print(f"📥 Input: {len(rows)} results\n")

    # Dedup
    before_dedup = len(rows)
    rows = deduplicate(rows)
    deduped = before_dedup - len(rows)
    if deduped:
        print(f"🧹 Deduplicated: {deduped} removed")

    # Filter location
    before_loc = len(rows)
    rows = [r for r in rows if check_location(r.get("Location", ""))]
    filtered_loc = before_loc - len(rows)
    if filtered_loc:
        print(f"📍 Location filter: {filtered_loc} removed (not London/hybrid/remote)")

    # Flag hot postings
    hot_count = 0
    for row in rows:
        posted = row.get("Posted", "")
        if is_hot(posted) and "🔥" not in row.get("Notes", ""):
            notes = row.get("Notes", "")
            row["Notes"] = ("🔥 " + notes).strip()
            hot_count += 1

    if hot_count:
        print(f"🔥 Hot postings flagged: {hot_count}")

    # Flag low salary
    low_count = 0
    for row in rows:
        salary = check_salary(row.get("Salary", ""))
        if salary is not None and salary < 25000:
            notes = row.get("Notes", "")
            if "⚠️" not in notes:
                row["Notes"] = (notes + " ⚠️ Below £25K").strip()
                low_count += 1

    if low_count:
        print(f"⚠️  Below £25K flagged: {low_count}")

    # Tier summary
    tiers = {}
    for row in rows:
        tier = row.get("Tier", "?")
        tiers[tier] = tiers.get(tier, 0) + 1

    print(f"\n📊 Summary: {len(rows)} results")
    for t in sorted(tiers.keys(), key=lambda x: str(x)):
        print(f"   Tier {t}: {tiers[t]}")

    print(f"\n{render_table(rows)}")


if __name__ == "__main__":
    main()