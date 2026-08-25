#!/usr/bin/env python3
"""
Extract abstracts from programm.html and add them to dhd2026_programm.json.

Parses the ConfTool HTML export to find abstracts for each presentation,
then matches them to the corresponding sessions/presentations in the JSON
program file.
"""

import json
import re
import html
from pathlib import Path

BASE_DIR = Path(__file__).parent / "static"
HTML_PATH = BASE_DIR / "programm.html"
JSON_PATH = BASE_DIR / "data" / "dhd2026_programm.json"


def normalize_title(title: str) -> str:
    """Normalize a title for comparison: decode HTML entities, normalize
    whitespace, dashes, and quotes, then lowercase."""
    t = html.unescape(title)
    # Normalize various dash types to a simple hyphen
    t = re.sub(r'[\u2013\u2014\u2012\u2015]', '-', t)  # en-dash, em-dash, etc.
    t = t.replace('---', '-')
    # Normalize various quote types
    t = re.sub(r'[\u201c\u201d\u201e\u201f\u00ab\u00bb]', '"', t)
    t = re.sub(r'[\u2018\u2019\u201a\u201b]', "'", t)
    # Normalize whitespace
    t = re.sub(r'\s+', ' ', t).strip()
    # Lowercase for comparison
    t = t.lower()
    return t


def titles_similar(a: str, b: str, threshold: float = 0.9) -> bool:
    """Check if two normalized titles are similar enough using
    difflib.SequenceMatcher."""
    if a == b:
        return True
    if not a or not b:
        return False
    from difflib import SequenceMatcher
    ratio = SequenceMatcher(None, a, b).ratio()
    return ratio >= threshold


def extract_sessions_from_html(html_content: str):
    """
    Extract sessions from the HTML. Each session is in a <tbody id='session_XXX'>.
    Returns a list of dicts with:
      - session_label: the bold text identifying the session (e.g. "Workshop 1",
        "Mittwoch, 1:3: Mittwoch, 1:3 - Forschungsdatenstandards")
      - session_id_normalized: the extracted session_id matching JSON format
      - presentations: list of dicts with 'title' and 'abstract'
    """
    sessions = []

    # Split HTML by tbody boundaries
    tbody_pattern = re.compile(r"<tbody\s+id='session_\d+'\s*>", re.IGNORECASE)
    tbody_positions = [(m.start(), m.end()) for m in tbody_pattern.finditer(html_content)]

    for i, (start, tag_end) in enumerate(tbody_positions):
        # Get content until next tbody or end of file
        if i + 1 < len(tbody_positions):
            end = tbody_positions[i + 1][0]
        else:
            end = len(html_content)

        block = html_content[start:end]

        # Extract the session label from bold text in <a> or <span> tags
        # Pattern 1: <a ...><b>LABEL</b></a>
        # Pattern 2: <span ...><b>LABEL</b></span>
        label_match = re.search(r'<b>([^<]+)</b>', block)
        if not label_match:
            continue

        session_label = html.unescape(label_match.group(1).strip())

        # Skip date headers, pauses, organizational items
        if session_label.startswith('Datum:'):
            continue
        if session_label in ('Kaffeepause', 'Mittagspause'):
            continue

        # Derive the session_id that matches JSON format
        session_id = derive_session_id(session_label)

        # Extract presentations (title + abstract) from this block
        presentations = extract_presentations_from_block(block)

        sessions.append({
            'session_label': session_label,
            'session_id': session_id,
            'presentations': presentations,
        })

    return sessions


def derive_session_id(label: str) -> str:
    """
    Convert HTML session label to JSON session_id format.

    Examples:
      "Workshop 1" -> "Workshop 1"
      "Mittwoch, 1:3: Mittwoch, 1:3 – Forschungsdatenstandards" -> "Mittwoch 1:3"
      "Donnerstag 1:1: Donnerstag 1:1 – Panel" -> "Donnerstag 1:1"
      "Eröffnungskeynote: Eröffnungskeynote" -> "Eröffnungskeynote"
      "Promovierende Digital History" -> "Promovierende Digital History"
    """
    # If label starts with "Workshop", return as-is
    if label.startswith('Workshop'):
        return label

    # Pattern: "Day, N:M: ..." or "Day N:M: ..."
    # e.g. "Mittwoch, 1:3: Mittwoch, 1:3 – Forschungsdatenstandards"
    # We want "Mittwoch 1:3"
    m = re.match(r'^(Mittwoch|Dienstag|Donnerstag|Freitag),?\s*(\d+(?::\d+)?)\s*:', label)
    if m:
        return f"{m.group(1)} {m.group(2)}"

    # Pattern: "Something: Something" (e.g. "Eröffnungskeynote: Eröffnungskeynote")
    # For these, extract the part before the colon
    m = re.match(r'^([^:]+):', label)
    if m:
        return m.group(1).strip()

    # Fallback: return the label as-is
    return label


def extract_presentations_from_block(block: str):
    """
    Extract all presentations from an HTML session block.
    Each presentation has a paper_title and zero or more paper_abstract paragraphs.
    """
    presentations = []

    # Find all paper divs - each starts with <div id='paperIDNNN'>
    paper_splits = re.split(r"<div\s+id='paperID\d+'>", block)

    for part in paper_splits[1:]:  # Skip the first chunk (before any paperID)
        # Extract title
        title_match = re.search(r'<p\s+class="paper_title">(.*?)</p>', part, re.DOTALL)
        if not title_match:
            continue
        title = html.unescape(title_match.group(1).strip())
        # Remove any remaining HTML tags from title
        title = re.sub(r'<[^>]+>', '', title).strip()

        # Extract all non-empty abstract paragraphs
        abstract_parts = []
        for abs_match in re.finditer(r'<p\s+class="paper_abstract">(.*?)</p>', part, re.DOTALL):
            text = abs_match.group(1).strip()
            if text:
                # Decode HTML entities and remove tags
                text = html.unescape(text)
                text = re.sub(r'<[^>]+>', '', text).strip()
                if text:
                    abstract_parts.append(text)

        abstract = '\n'.join(abstract_parts) if abstract_parts else ''

        presentations.append({
            'title': title,
            'abstract': abstract,
        })

    return presentations


def clean_json(json_data):
    """Remove any previously added abstracts and dynamically-added presentations
    arrays so the script is idempotent."""
    for day in json_data['days']:
        for session in day['sessions']:
            session.pop('abstract', None)
            if 'presentations' in session:
                for pres in session['presentations']:
                    pres.pop('abstract', None)


def match_and_update(json_data, html_sessions):
    """
    Match HTML sessions to JSON sessions and add abstracts.
    Returns count of abstracts added.
    """
    # Clean first for idempotency
    clean_json(json_data)

    abstracts_added = 0
    unmatched_html_sessions = []
    matched_session_ids = set()

    # Build a lookup: session_id -> html_session
    html_by_id = {}
    for hs in html_sessions:
        sid = hs['session_id']
        if sid:
            html_by_id[sid] = hs

    # Also build title-based lookup for presentations across all HTML sessions
    # normalized_title -> abstract
    all_html_presentations = {}
    for hs in html_sessions:
        for pres in hs['presentations']:
            norm = normalize_title(pres['title'])
            all_html_presentations[norm] = pres['abstract']

    for day in json_data['days']:
        for session in day['sessions']:
            json_sid = session.get('session_id', '')

            # Try to find matching HTML session
            html_session = html_by_id.get(json_sid)

            if html_session is None and json_sid:
                # Try fuzzy match on session_id (e.g. with/without comma)
                for hid, hs in html_by_id.items():
                    if normalize_title(hid) == normalize_title(json_sid):
                        html_session = hs
                        break

            if html_session is None:
                # Try matching by session title for sessions without session_id
                json_title_norm = normalize_title(session.get('title', ''))
                for hs in html_sessions:
                    # Match by title of first presentation or session label
                    if hs['presentations']:
                        first_pres_norm = normalize_title(hs['presentations'][0]['title'])
                        if first_pres_norm == json_title_norm:
                            html_session = hs
                            break
                    # Also try matching session label contains the title
                    label_norm = normalize_title(hs['session_label'])
                    if json_title_norm and json_title_norm in label_norm:
                        html_session = hs
                        break

            if html_session is None:
                continue

            matched_session_ids.add(html_session['session_id'])
            html_presentations = html_session['presentations']

            if 'presentations' in session:
                # Session has a presentations array - match each presentation by title
                for json_pres in session['presentations']:
                    json_pres_title_norm = normalize_title(json_pres.get('title', ''))
                    matched = False

                    # Try to match within this HTML session's presentations
                    for html_pres in html_presentations:
                        html_pres_title_norm = normalize_title(html_pres['title'])
                        if json_pres_title_norm == html_pres_title_norm:
                            if html_pres['abstract']:
                                json_pres['abstract'] = html_pres['abstract']
                                abstracts_added += 1
                            matched = True
                            break

                    # Fallback: fuzzy match within session
                    if not matched:
                        for html_pres in html_presentations:
                            html_pres_title_norm = normalize_title(html_pres['title'])
                            if titles_similar(json_pres_title_norm, html_pres_title_norm):
                                if html_pres['abstract']:
                                    json_pres['abstract'] = html_pres['abstract']
                                    abstracts_added += 1
                                matched = True
                                break

                    # Fallback: try global title match (exact then fuzzy)
                    if not matched:
                        if json_pres_title_norm in all_html_presentations:
                            abstract = all_html_presentations[json_pres_title_norm]
                            if abstract:
                                json_pres['abstract'] = abstract
                                abstracts_added += 1
                                matched = True
                        if not matched:
                            for norm_t, abstract in all_html_presentations.items():
                                if titles_similar(json_pres_title_norm, norm_t):
                                    if abstract:
                                        json_pres['abstract'] = abstract
                                        abstracts_added += 1
                                    break
            else:
                # Session without presentations array (Workshops, Panels, Keynotes)
                # If there's exactly one presentation in HTML, add abstract to session
                if len(html_presentations) == 1 and html_presentations[0]['abstract']:
                    session['abstract'] = html_presentations[0]['abstract']
                    abstracts_added += 1
                elif len(html_presentations) > 1:
                    # Multiple presentations but no presentations array in JSON
                    # First try to match session title to one of the presentations
                    json_title_norm = normalize_title(session.get('title', ''))
                    title_matched = False
                    for html_pres in html_presentations:
                        html_pres_title_norm = normalize_title(html_pres['title'])
                        if json_title_norm == html_pres_title_norm and html_pres['abstract']:
                            session['abstract'] = html_pres['abstract']
                            abstracts_added += 1
                            title_matched = True
                            break

                    if not title_matched:
                        # Create a presentations array with titles and abstracts
                        # from HTML (for poster sessions, panels with multiple talks, etc.)
                        pres_list = []
                        for hp in html_presentations:
                            entry = {"title": hp['title']}
                            if hp['abstract']:
                                entry['abstract'] = hp['abstract']
                            pres_list.append(entry)
                        if pres_list:
                            session['presentations'] = pres_list
                            abstracts_added += sum(1 for p in pres_list if 'abstract' in p)

    # Report unmatched HTML sessions
    for hs in html_sessions:
        if hs['session_id'] not in matched_session_ids:
            if hs['presentations'] and any(p['abstract'] for p in hs['presentations']):
                unmatched_html_sessions.append(hs['session_label'])

    return abstracts_added, unmatched_html_sessions


def main():
    print("Reading HTML file...")
    html_content = HTML_PATH.read_text(encoding='utf-8')

    print("Reading JSON file...")
    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        json_data = json.load(f)

    print("Extracting sessions from HTML...")
    html_sessions = extract_sessions_from_html(html_content)

    total_html_presentations = sum(len(s['presentations']) for s in html_sessions)
    total_with_abstract = sum(
        1 for s in html_sessions
        for p in s['presentations']
        if p['abstract']
    )
    print(f"  Found {len(html_sessions)} sessions in HTML")
    print(f"  Found {total_html_presentations} presentations in HTML")
    print(f"  Of which {total_with_abstract} have non-empty abstracts")

    # Count JSON sessions/presentations before
    json_sessions_count = 0
    json_presentations_count = 0
    for day in json_data['days']:
        for session in day['sessions']:
            json_sessions_count += 1
            if 'presentations' in session:
                json_presentations_count += len(session['presentations'])

    print(f"\n  Found {json_sessions_count} sessions in JSON")
    print(f"  Found {json_presentations_count} presentations in JSON (in sessions with presentations arrays)")

    print("\nMatching and updating...")
    abstracts_added, unmatched = match_and_update(json_data, html_sessions)

    print(f"\n=== RESULTS ===")
    print(f"  Abstracts added: {abstracts_added}")

    if unmatched:
        print(f"\n  Unmatched HTML sessions with abstracts ({len(unmatched)}):")
        for label in unmatched:
            print(f"    - {label}")

    # Verify JSON is valid by re-serializing
    print("\nWriting updated JSON...")
    json_output = json.dumps(json_data, indent=2, ensure_ascii=False)
    JSON_PATH.write_text(json_output, encoding='utf-8')
    print(f"  Written {len(json_output)} bytes to {JSON_PATH}")

    # Verify by re-reading
    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        verify = json.load(f)

    # Count abstracts in final JSON
    session_abstracts = 0
    presentation_abstracts = 0
    for day in verify['days']:
        for session in day['sessions']:
            if 'abstract' in session:
                session_abstracts += 1
            if 'presentations' in session:
                for pres in session['presentations']:
                    if 'abstract' in pres:
                        presentation_abstracts += 1

    print(f"\n=== VERIFICATION ===")
    print(f"  Session-level abstracts: {session_abstracts}")
    print(f"  Presentation-level abstracts: {presentation_abstracts}")
    print(f"  Total abstracts in JSON: {session_abstracts + presentation_abstracts}")
    print("  JSON is valid: Yes")


if __name__ == '__main__':
    main()
