# My DHd App

A personal conference companion for [DHd 2026](https://dhd2026.digitalhumanities.de/) – the annual conference of the Association for Digital Humanities in the German-speaking world, held in Marburg (01–05 March 2027).

## Features

- Browse the full conference programme (sessions, talks, posters, workshops)
- Filter by day and time slot
- Bookmark individual sessions, talks, and posters
- **"Mein Programm"** tab shows only your saved items, sorted by time
- Person index – search all speakers and chairs, jump to their sessions
- Share links to individual sessions or presentations
- Optional user account for cross-device bookmark sync
- Works offline-first: bookmarks are always saved locally in the browser
- ** Further features are in development **

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JavaScript, HTML, CSS |
| Backend | Python / Flask |
| Database | SQLite (user accounts & bookmarks) |
| Icons | Google Material Icons |

## Project structure

```
.
├── server.py                   # Flask backend (auth, bookmark sync API)
├── static/
│   ├── index.html              # Single-page app shell
│   ├── app.js                  # Frontend logic
│   ├── style.css               # Styles
│   └── dhd2026_programm.json   # Conference programme data (will be substituted by the dhd 2027 programe)
├── extract_abstracts.py        # Data extraction helper
├── extract_authors.py          # Data extraction helper
└── conference.db               # SQLite database (git-ignored)
```

## Running locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install flask werkzeug
python server.py
```

The app will be available at `http://localhost:5000`.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/register` | Create a new account |
| POST | `/api/login` | Log in |
| POST | `/api/logout` | Log out |
| GET | `/api/me` | Get current user & bookmarks |
| POST | `/api/save_program` | Sync bookmarks to server |

## Credits

Source-Codebase developed by **Tinghui Duan** / [Grid Creators](https://www.grid-creators.com), further developed and revised for the DHd 2027 by the team at the **Marburg Center for Digital Culture and Infrastructure (MCDCI)**.

