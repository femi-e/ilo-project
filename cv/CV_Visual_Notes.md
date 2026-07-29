# CV Visual Notes — Applied Design Choices

Based on 2026 ATS and recruiter best-practice research. Applied to the .docx version of your CV.

---

## Font: Calibri

ATS-safe. Clean. Default system font. No serif, no decorative. 10.5pt body, 16pt name, 12pt section headers.

## Layout: Single Column

ATS reads left to right, top to bottom. Two-column layouts scramble text. No sidebars, no tables, no icons. No "dashboard-style" resume — ironic for a data analyst, but the research is clear: it breaks parsers.

## Margins: 0.7in top/bottom, 0.75in left/right

Wide enough for white space. Narrow enough to fit content on one page.

## Line Spacing: 1.08

Tighter than 1.15 but not cramped. Fits more content without looking dense.

## Section Header Spacing: 12pt before, 4pt after

Creates visual breaks between sections. A thin grey bottom border adds hierarchy without adding a heavy line.

## Section Headers: Bold 12pt with subtle bottom border

Standard naming: "Professional Summary", "Technical Skills", "Projects", "Experience", "Education". No creative names. The research says "Analytical Toolkit" or "Data Adventures" will confuse ATS parsers.

## Name: 16pt Bold, Centered

Largest element on the page. Sets visual hierarchy. Contact info below in smaller, lighter text.

## Bullet Points: Hanging indent, tight spacing

1pt between bullets. 0.25in left indent. Keeps the page from looking like a wall of text while staying compact enough for one page.

## Project Titles: Bold 10.5pt + italic 9.5pt grey tool list

Clear separation between project name and technical context. The grey text signals "metadata" to the reader.

## Experience Headers: Bold title, regular company, grey dates

Same visual pattern as projects. The date recedes so the reader sees the role and company first.

## No Horizontal Rules

The markdown had `---` dividers. The docx uses spacing instead. Horizontal rules add visual noise and can confuse some parsers.

## No Icons, No Logos, No Colour (except grey and blue links)

Black text on white. Grey for metadata. Blue for links. That's it. The research says colour accents and icons break ATS parsing and add no value for a data analyst CV.

## File Format: .docx

Workday and Greenhouse parse .docx more reliably than .pdf. Always submit .docx unless a company explicitly requests PDF.

---

## Summary of Rules Applied

| Rule | Applied | Notes |
| ------ | --------- | ------- |
| Single column | Yes | |
| Standard section headings | Yes | |
| Calibri font | Yes | |
| No tables | Yes | |
| No images/icons | Yes | |
| No colour blocks | Yes | |
| 10-12pt body | Yes | 10.5pt |
| 0.5-0.8in margins | Yes | 0.7-0.75in |
| One page | Yes | |
| .docx format | Yes | |
| SSO / MFA | Yes | |
| Links in body (not header/footer) | Yes | |
| Quantified results | Yes | Every bullet has a number |
| Tools named in context | Yes | |
| No em dashes | Yes | |
| Active voice | Yes | |
