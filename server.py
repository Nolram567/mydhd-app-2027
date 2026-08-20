import sqlite3
import json
import os
import secrets
from datetime import datetime, timezone
from flask import Flask, request, jsonify, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__, static_folder='static', static_url_path='')
app.secret_key = os.environ.get('FLASK_SECRET_KEY', secrets.token_hex(32))

# Only serve files from an explicit static directory
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

# Database setup
DB_NAME = 'conference.db'

def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                saved_sessions TEXT DEFAULT '[]',
                created_at TEXT,
                last_login_at TEXT
            )
        ''')
        # Migrate: add columns if they don't exist yet
        existing = [row[1] for row in conn.execute('PRAGMA table_info(users)').fetchall()]
        if 'created_at' not in existing:
            conn.execute('ALTER TABLE users ADD COLUMN created_at TEXT')
        if 'last_login_at' not in existing:
            conn.execute('ALTER TABLE users ADD COLUMN last_login_at TEXT')
        if 'saved_posters' not in existing:
            conn.execute("ALTER TABLE users ADD COLUMN saved_posters TEXT DEFAULT '[]'")
        if 'saved_talks' not in existing:
            conn.execute("ALTER TABLE users ADD COLUMN saved_talks TEXT DEFAULT '[]'")
        conn.execute('''
            CREATE TABLE IF NOT EXISTS login_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                login_at TEXT NOT NULL,
                FOREIGN KEY (username) REFERENCES users(username)
            )
        ''')
        conn.commit()

init_db()

def hash_password(password):
    return generate_password_hash(password)

def check_password(password, password_hash):
    return check_password_hash(password_hash, password)

def require_login(f):
    """Decorator to require a valid session for API endpoints."""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'username' not in session:
            return jsonify({'error': 'Nicht eingeloggt.'}), 401
        return f(*args, **kwargs)
    return decorated

@app.route('/')
def root():
    return send_from_directory(STATIC_DIR, 'index.html')

@app.route('/Lageplan.pdf')
def lageplan():
    return send_from_directory(os.path.dirname(os.path.abspath(__file__)), 'Lageplan.pdf')

@app.route('/<path:path>')
def send_static(path):
    return send_from_directory(STATIC_DIR, path)

@app.route('/api/register', methods=['POST'])
def register():
    data = request.json
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    if not username or not password:
        return jsonify({'error': 'Benutzername und Passwort erforderlich.'}), 400

    if len(username) < 3 or len(username) > 30:
        return jsonify({'error': 'Benutzername muss zwischen 3 und 30 Zeichen lang sein.'}), 400

    if len(password) < 8:
        return jsonify({'error': 'Passwort muss mindestens 8 Zeichen lang sein.'}), 400

    pwd_hash = hash_password(password)

    now = datetime.now(timezone.utc).isoformat()
    try:
        with get_db() as conn:
            conn.execute('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', (username, pwd_hash, now))
            conn.commit()
        return jsonify({'message': 'Registrierung erfolgreich.'}), 201
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Benutzername bereits vergeben.'}), 409

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    if not username or not password:
        return jsonify({'error': 'Benutzername und Passwort erforderlich.'}), 400

    with get_db() as conn:
        row = conn.execute('SELECT password_hash, saved_sessions, saved_posters, saved_talks FROM users WHERE username = ?', (username,)).fetchone()

    if row and check_password(password, row['password_hash']):
        session['username'] = username
        now = datetime.now(timezone.utc).isoformat()
        with get_db() as conn:
            conn.execute('UPDATE users SET last_login_at = ? WHERE username = ?', (now, username))
            conn.execute('INSERT INTO login_history (username, login_at) VALUES (?, ?)', (username, now))
            conn.commit()
        return jsonify({
            'message': 'Login erfolgreich.',
            'saved_sessions': json.loads(row['saved_sessions']),
            'saved_posters': json.loads(row['saved_posters'] or '[]'),
            'saved_talks': json.loads(row['saved_talks'] or '[]'),
        }), 200
    else:
        return jsonify({'error': 'Ungültige Anmeldedaten.'}), 401

@app.route('/api/logout', methods=['POST'])
def logout():
    session.pop('username', None)
    return jsonify({'message': 'Logout erfolgreich.'}), 200

@app.route('/api/me')
@require_login
def me():
    username = session['username']
    with get_db() as conn:
        row = conn.execute('SELECT saved_sessions, saved_posters, saved_talks FROM users WHERE username = ?', (username,)).fetchone()
    if not row:
        session.pop('username', None)
        return jsonify({'error': 'Benutzer nicht gefunden.'}), 401
    return jsonify({
        'username': username,
        'saved_sessions': json.loads(row['saved_sessions']),
        'saved_posters': json.loads(row['saved_posters'] or '[]'),
        'saved_talks': json.loads(row['saved_talks'] or '[]'),
    }), 200

@app.route('/api/save_program', methods=['POST'])
@require_login
def save_program():
    data = request.json
    sessions_list = data.get('sessions')
    posters_list = data.get('posters', [])
    talks_list = data.get('talks', [])

    if sessions_list is None or not isinstance(sessions_list, list):
        return jsonify({'error': 'Ungültige Daten.'}), 400

    username = session['username']

    with get_db() as conn:
        conn.execute(
            'UPDATE users SET saved_sessions = ?, saved_posters = ?, saved_talks = ? WHERE username = ?',
            (json.dumps(sessions_list), json.dumps(posters_list), json.dumps(talks_list), username)
        )
        conn.commit()

    return jsonify({'message': 'Programm gespeichert.'}), 200

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    debug = os.environ.get('FLASK_DEBUG', '1') == '1'
    print(f"Starting Flask server on http://localhost:{port}")
    app.run(host='0.0.0.0', port=port, debug=debug)
