#!/usr/bin/env python3
"""
Extract authors from programm.html and add them to dhd2026_programm.json.

Parses the ConfTool HTML export to find authors for each presentation,
then matches them to the corresponding presentations in the JSON program file.
"""

import json
import re
import html as htmlmod
from pathlib import Path

BASE_DIR = Path(__file__).parent / "static"
HTML_PATH = BASE_DIR / "programm.html"
JSON_PATH = BASE_DIR / "data" / "dhd2026_programm.json"


def normalize_title(title: str) -> str:
    """Normalize a title for comparison."""
    t = htmlmod.unescape(title)
    t = re.sub(r'[\u2013\u2014\u2012\u2015]', '-', t)
    t = t.replace('---', '-')
    t = re.sub(r'[\u201c\u201d\u201e\u201f\u00ab\u00bb]', '"', t)
    t = re.sub(r'[\u2018\u2019\u201a\u201b]', "'", t)
    t = re.sub(r'\s+', ' ', t).strip()
    t = t.lower()
    return t


def titles_similar(a: str, b: str, threshold: float = 0.9) -> bool:
    if a == b:
        return True
    if not a or not b:
        return False
    from difflib import SequenceMatcher
    return SequenceMatcher(None, a, b).ratio() >= threshold


def extract_authors_from_html(html_content: str):
    """
    Extract all presentations with their authors from the HTML.
    Returns a dict mapping normalized_title -> {authors: [...], affiliations: [...]}
    """
    results = {}

    # Split by paper divs
    paper_splits = re.split(r"<div\s+id='paperID\d+'>", html_content)

    for part in paper_splits[1:]:
        # Extract title
        title_match = re.search(r'<p\s+class="paper_title">(.*?)</p>', part, re.DOTALL)
        if not title_match:
            continue
        title = htmlmod.unescape(title_match.group(1).strip())
        title = re.sub(r'<[^>]+>', '', title).strip()

        # Extract authors from paper_author
        author_match = re.search(r'<p\s+class="paper_author">(.*?)</p>', part, re.DOTALL)
        if not author_match:
            continue

        author_html = author_match.group(1)

        # Extract all author names (both underlined/presenting and non-underlined)
        # Remove sup tags and their content first (may contain commas like <sup>1, 2</sup>)
        author_clean = re.sub(r'<sup>.*?</sup>', '', author_html)
        # Remove <u> tags
        author_clean = re.sub(r'</?u>', '', author_clean)
        # Remove any other HTML tags
        author_clean = re.sub(r'<[^>]+>', '', author_clean)
        author_clean = htmlmod.unescape(author_clean)

        # Split by comma and clean up
        authors = []
        for chunk in author_clean.split(','):
            chunk = chunk.strip()
            name = chunk.strip()
            if name:
                authors.append(name)

        # Extract affiliations from paper_organisation
        org_match = re.search(r'<p\s+class="paper_organisation">(.*?)</p>', part, re.DOTALL)
        affiliations = []
        if org_match:
            org_html = org_match.group(1)
            org_clean = htmlmod.unescape(org_html)
            # Parse affiliations with their sup numbers
            # Pattern: <sup>N</sup>Affiliation; or just Affiliation (no sup)
            org_clean = re.sub(r'<sup>\d+</sup>', '|||', org_clean)
            for chunk in org_clean.split('|||'):
                chunk = chunk.strip().rstrip(';').strip()
                if chunk:
                    affiliations.append(chunk)

        norm_title = normalize_title(title)
        results[norm_title] = {
            'authors': authors,
            'affiliations': affiliations,
        }

    return results


def extract_chairs_from_html(html_content: str):
    """
    Extract session chairs from HTML.
    Returns a dict mapping session label -> chair string
    """
    chairs = {}
    # Chair pattern: "Chair der Sitzung: <span ...>Name, Affiliation</span>"
    tbody_pattern = re.compile(r"<tbody\s+id='session_\d+'\s*>", re.IGNORECASE)
    tbody_positions = [(m.start(), m.end()) for m in tbody_pattern.finditer(html_content)]

    for i, (start, tag_end) in enumerate(tbody_positions):
        if i + 1 < len(tbody_positions):
            end = tbody_positions[i + 1][0]
        else:
            end = len(html_content)

        block = html_content[start:end]

        # Extract session label
        label_match = re.search(r'<b>([^<]+)</b>', block)
        if not label_match:
            continue
        session_label = htmlmod.unescape(label_match.group(1).strip())

        # Extract chair
        chair_match = re.search(r'Chair der Sitzung:\s*</span>\s*<span[^>]*>(.*?)</span>', block, re.DOTALL)
        if chair_match:
            chair_text = htmlmod.unescape(chair_match.group(1).strip())
            chair_text = re.sub(r'<[^>]+>', '', chair_text).strip()
            chairs[session_label] = chair_text

    return chairs


def derive_session_id(label: str) -> str:
    """Convert HTML session label to JSON session_id format."""
    if label.startswith('Workshop'):
        return label
    m = re.match(r'^(Mittwoch|Dienstag|Donnerstag|Freitag),?\s*(\d+(?::\d+)?)\s*:', label)
    if m:
        return f"{m.group(1)} {m.group(2)}"
    m = re.match(r'^([^:]+):', label)
    if m:
        return m.group(1).strip()
    return label


def main():
    print("Reading HTML file...")
    html_content = HTML_PATH.read_text(encoding='utf-8')

    print("Reading JSON file...")
    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        json_data = json.load(f)

    print("Extracting authors from HTML...")
    html_authors = extract_authors_from_html(html_content)
    print(f"  Found {len(html_authors)} presentations with authors in HTML")

    print("Extracting chairs from HTML...")
    html_chairs = extract_chairs_from_html(html_content)
    print(f"  Found {len(html_chairs)} sessions with chairs in HTML")

    authors_added = 0
    chairs_added = 0

    for day in json_data['days']:
        for session in day['sessions']:
            # Check and add chairs
            json_sid = session.get('session_id', '')
            if json_sid and 'chair' not in session:
                # Try to find matching chair from HTML
                for label, chair in html_chairs.items():
                    derived = derive_session_id(label)
                    if derived == json_sid:
                        session['chair'] = chair
                        chairs_added += 1
                        print(f"  Added chair for {json_sid}: {chair}")
                        break

            if 'presentations' not in session:
                continue

            for pres in session['presentations']:
                # Always re-extract authors from HTML to ensure correctness

                pres_title_norm = normalize_title(pres.get('title', ''))
                if not pres_title_norm:
                    continue

                # Try exact match
                matched = False
                if pres_title_norm in html_authors:
                    data = html_authors[pres_title_norm]
                    pres['authors'] = data['authors']
                    if data['affiliations']:
                        pres['affiliation'] = '; '.join(data['affiliations'])
                    authors_added += 1
                    matched = True

                # Try fuzzy match
                if not matched:
                    for norm_t, data in html_authors.items():
                        if titles_similar(pres_title_norm, norm_t):
                            pres['authors'] = data['authors']
                            if data['affiliations']:
                                pres['affiliation'] = '; '.join(data['affiliations'])
                            authors_added += 1
                            matched = True
                            break

                if not matched:
                    print(f"  WARNING: No author match for: {pres.get('title', '')[:80]}")

    print(f"\n=== RESULTS ===")
    print(f"  Authors added to {authors_added} presentations")
    print(f"  Chairs added to {chairs_added} sessions")

    # Write updated JSON
    print("\nWriting updated JSON...")
    json_output = json.dumps(json_data, indent=2, ensure_ascii=False)
    JSON_PATH.write_text(json_output, encoding='utf-8')
    print(f"  Written {len(json_output)} bytes to {JSON_PATH}")

    # Verify
    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        verify = json.load(f)

    total_with_authors = 0
    total_without = 0
    for day in verify['days']:
        for session in day['sessions']:
            if 'presentations' in session:
                for pres in session['presentations']:
                    if pres.get('authors'):
                        total_with_authors += 1
                    else:
                        total_without += 1

    print(f"\n=== VERIFICATION ===")
    print(f"  Presentations with authors: {total_with_authors}")
    print(f"  Presentations without authors: {total_without}")
    print("  JSON is valid: Yes")


if __name__ == '__main__':
    main()
