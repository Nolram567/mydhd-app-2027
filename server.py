import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dotenv import load_dotenv
from flask import Flask, request, jsonify, send_from_directory, render_template

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

app = Flask(__name__, static_folder='static', static_url_path='')

# Only serve files from an explicit static directory
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

@app.route('/')
@app.route('/index.html')
def root():
    return render_template('index.html')

@app.route('/lageplan.html')
def lageplan_page():
    return render_template('lageplan.html')

@app.route('/news-feed.html')
def news_feed_page():
    return render_template('news_feed.html')

@app.route('/aktuelles.html')
def aktuelles_page():
    return render_template('aktuelles.html')

@app.route('/Lageplan.pdf')
def lageplan():
    return send_from_directory(os.path.join(STATIC_DIR, 'assets'), 'Lageplan.pdf')

@app.route('/<path:path>')
def send_static(path):
    return send_from_directory(STATIC_DIR, path)

@app.route('/api/mastodon/timelines/tag/<hashtag>')
def mastodon_hashtag_timeline(hashtag):
    """Proxy fedihum.org hashtag timelines using a server-side read token."""
    token = os.environ.get('MASTODON_ACCESS_TOKEN')
    if not token:
        return jsonify({
            'error': 'Die Hashtag-Timeline erfordert ein Mastodon-Token. '
                     'Bitte MASTODON_ACCESS_TOKEN auf dem Server konfigurieren.'
        }), 503

    hashtag = hashtag.lstrip('#')
    if not re.fullmatch(r'[\w-]{1,100}', hashtag, flags=re.UNICODE):
        return jsonify({'error': 'Ungültiger Hashtag.'}), 400

    params = {'limit': '40'}
    max_id = request.args.get('max_id')
    if max_id:
        params['max_id'] = max_id
    url = f'https://fedihum.org/api/v1/timelines/tag/{urllib.parse.quote(hashtag)}'
    url = f'{url}?{urllib.parse.urlencode(params)}'
    api_request = urllib.request.Request(
        url,
        headers={
            'Accept': 'application/json',
            'Authorization': f'Bearer {token}',
            'User-Agent': 'MyDHd-App/1.0',
        },
    )

    try:
        with urllib.request.urlopen(api_request, timeout=15) as response:
            return jsonify(json.loads(response.read().decode('utf-8')))
    except urllib.error.HTTPError as error:
        return jsonify({'error': f'Mastodon API meldet HTTP {error.code}.'}), error.code
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return jsonify({'error': 'Die Mastodon-Hashtag-Timeline ist momentan nicht erreichbar.'}), 502

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    debug = os.environ.get('FLASK_DEBUG', '1') == '1'
    print(f"Starting Flask server on http://localhost:{port}")
    app.run(host='0.0.0.0', port=port, debug=debug)
