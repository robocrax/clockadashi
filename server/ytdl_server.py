#!/usr/bin/env python3
"""
Clockadashi song server: YouTube Music search + yt-dlp downloads.

The clock's Search tab asks this server for YouTube Music results. Tapping a
result sends its link (music.youtube.com/watch?v=...) here; yt-dlp downloads
the audio, and the clock copies it into the browser's offline storage, where
it stays across refreshes and restarts.

  python ytdl_server.py                       # http://127.0.0.1:8790
  python ytdl_server.py --host 0.0.0.0 --token SECRET   # reachable from other devices

Needs:  pip install -U "yt-dlp[default]" ytmusicapi
        and Deno or Node.js on PATH (YouTube needs a JavaScript runtime).
YouTube changes often; when downloads start failing, update yt-dlp first.

Endpoints (all JSON unless noted):
  GET  /health                       versions, JS runtime
  GET  /search?q=...&type=songs      YouTube Music results (type: songs | videos)
  POST /download?id=VIDEO_ID&thumb=URL   start (or join) a download
  GET  /status?id=VIDEO_ID           queued / downloading (progress 0..1) / ready / error
  GET  /audio/VIDEO_ID               the audio file (supports Range)
  GET  /art/VIDEO_ID                 the artwork (jpg)
"""
import argparse
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    import yt_dlp
    from ytmusicapi import YTMusic
except ImportError as missing:
    sys.exit('Missing %s. Install with:  pip install -U "yt-dlp[default]" ytmusicapi' % missing.name)

VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
DEFAULT_ORIGINS = ['https://clock.nehal.boo', 'http://localhost:8642', 'http://127.0.0.1:8642']
AUDIO_TYPES = {'.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg',
               '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg'}
USER_AGENT = 'Mozilla/5.0 (clockadashi song server)'


def say(*parts):
    print(time.strftime('%H:%M:%S'), *parts, flush=True)


def seconds(text):
    """'1:02:03' -> 3723"""
    if not text:
        return 0
    total = 0
    for part in str(text).split(':'):
        if not part.isdigit():
            return 0
        total = total * 60 + int(part)
    return total


def big_thumb(thumbs):
    """Largest thumbnail; YouTube Music's square art is resized to 544px."""
    if not thumbs:
        return ''
    url = max(thumbs, key=lambda t: t.get('width') or 0).get('url') or ''
    return re.sub(r'=w\d+-h\d+(-[^/?#]*)?$', '=w544-h544-l90-rj', url)


class Library:
    """Search and downloads, shared by every request thread."""

    def __init__(self, folder, js_runtime):
        self.folder = folder
        self.js_runtime = js_runtime
        self.jobs = {}
        self.lock = threading.Lock()
        self.slots = threading.Semaphore(2)  # at most two yt-dlp downloads at a time
        self.yt = None                       # created on first search, so the server can start offline
        self.yt_lock = threading.Lock()      # YTMusic shares one HTTP session

    # ---- search ----------------------------------------------------------
    def search(self, query, kind):
        with self.yt_lock:
            if self.yt is None:
                self.yt = YTMusic()
            found = self.yt.search(query, filter=kind, limit=20)
        results = []
        for r in found:
            vid = r.get('videoId') or ''
            if not VIDEO_ID.match(vid):
                continue
            results.append({
                'id': vid,
                'kind': 'song' if r.get('resultType') == 'song' else 'video',
                'title': r.get('title') or '',
                'artist': ', '.join(a['name'] for a in (r.get('artists') or []) if a.get('name')),
                'album': (r.get('album') or {}).get('name') or '',
                'duration': r.get('duration_seconds') or seconds(r.get('duration')),
                'thumb': big_thumb(r.get('thumbnails')),
                'saved': bool(self.audio_file(vid)),
            })
        return results

    # ---- files -------------------------------------------------------------
    def audio_file(self, vid):
        for ext in AUDIO_TYPES:
            path = os.path.join(self.folder, vid + ext)
            if os.path.isfile(path):
                return path
        return None

    def art_file(self, vid):
        return os.path.join(self.folder, vid + '.jpg')

    def fetch_art(self, vid, url):
        """Save the artwork next to the audio. Falls back to YouTube's own thumbnail."""
        target = self.art_file(vid)
        if os.path.isfile(target):
            return
        for candidate in [url, 'https://i.ytimg.com/vi/%s/hq720.jpg' % vid, 'https://i.ytimg.com/vi/%s/mqdefault.jpg' % vid]:
            if not candidate or not candidate.startswith('https://'):
                continue
            try:
                req = urllib.request.Request(candidate, headers={'User-Agent': USER_AGENT})
                with urllib.request.urlopen(req, timeout=20) as res, open(target + '.part', 'wb') as out:
                    shutil.copyfileobj(res, out)
                os.replace(target + '.part', target)
                return
            except Exception as e:  # try the next one
                say('artwork', vid, 'failed from', candidate[:60], '-', e)

    # ---- downloads -----------------------------------------------------------
    def status(self, vid):
        with self.lock:
            job = self.jobs.get(vid)
            if job:
                return dict(job)
        path = self.audio_file(vid)
        return self.ready(vid, path) if path else {'id': vid, 'state': 'none'}

    def ready(self, vid, path):
        ext = os.path.splitext(path)[1].lower()
        return {'id': vid, 'state': 'ready', 'progress': 1.0, 'size': os.path.getsize(path),
                'type': AUDIO_TYPES.get(ext, 'application/octet-stream')}

    def start(self, vid, thumb):
        with self.lock:
            job = self.jobs.get(vid)
            if job and job['state'] in ('queued', 'downloading', 'ready'):
                return dict(job)
            path = self.audio_file(vid)
            if path:
                job = self.jobs[vid] = self.ready(vid, path)
                if not os.path.isfile(self.art_file(vid)):
                    threading.Thread(target=self.fetch_art, args=(vid, thumb), daemon=True).start()
                return dict(job)
            job = self.jobs[vid] = {'id': vid, 'state': 'queued', 'progress': 0.0}
        threading.Thread(target=self.download, args=(vid, thumb), daemon=True).start()
        return dict(job)

    def update(self, vid, **fields):
        with self.lock:
            self.jobs.setdefault(vid, {'id': vid}).update(fields)

    def download(self, vid, thumb):
        def progress(d):
            if d.get('status') == 'downloading':
                total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
                done = d.get('downloaded_bytes') or 0
                self.update(vid, state='downloading', progress=round(min(0.99, done / total), 3) if total else 0.0)

        options = {
            'format': 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio',
            'outtmpl': os.path.join(self.folder, '%(id)s.%(ext)s'),
            'noplaylist': True,
            'quiet': True,
            'no_warnings': True,
            'noprogress': True,
            'retries': 10,
            'fragment_retries': 10,
            'socket_timeout': 30,
            'progress_hooks': [progress],
        }
        if self.js_runtime:
            options['js_runtimes'] = {self.js_runtime: {}}
        link = 'https://music.youtube.com/watch?v=' + vid
        with self.slots:
            started = time.time()
            say('download', link)
            self.update(vid, state='downloading', progress=0.0)
            self.fetch_art(vid, thumb)
            message = ''
            # YouTube sometimes answers 403 for one player client and not the next; a fresh
            # lookup gets new links, so retry a couple of times unless the video is truly gone.
            for attempt in range(1, 4):
                try:
                    with yt_dlp.YoutubeDL(options) as ydl:
                        ydl.extract_info(link, download=True)
                    message = '' if self.audio_file(vid) else 'yt-dlp finished without writing an audio file'
                    break
                except Exception as e:
                    message = re.sub(r'\x1b\[[0-9;]*m', '', str(e)).replace('ERROR: ', '').strip()[:300] or 'download failed'
                    say('attempt %d failed for %s: %s' % (attempt, vid, message))
                    if re.search(r'unavailable|private|removed|members|confirm your age|copyright', message, re.I):
                        break
                    time.sleep(4 * attempt)
            path = self.audio_file(vid)
            if path and not message:
                self.update(vid, **self.ready(vid, path))
                say('ready', vid, '%.1f MB in %.0fs' % (os.path.getsize(path) / 1048576, time.time() - started))
            else:
                self.update(vid, state='error', error=message)


class Handler(BaseHTTPRequestHandler):
    server_version = 'ClockadashiSongs/1'
    library = None
    origins = set()
    token = ''

    # ---- plumbing ------------------------------------------------------------
    def log_message(self, fmt, *args):  # requests are logged by say() where useful
        pass

    def origin(self):
        return self.headers.get('Origin') or ''

    def cors(self):
        o = self.origin()
        if o and (o in self.origins or '*' in self.origins):
            self.send_header('Access-Control-Allow-Origin', o)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag')

    def allowed(self):
        o = self.origin()
        if o and o not in self.origins and '*' not in self.origins:
            self.reply(403, {'error': 'This page (%s) is not allowed. Start the server with --origin %s' % (o, o)})
            return False
        if self.token:
            q = parse_qs(urlparse(self.path).query)
            given = self.headers.get('X-Token') or (q.get('token') or [''])[0]
            if given != self.token:
                self.reply(401, {'error': 'Wrong or missing token'})
                return False
        return True

    def reply(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def send_file(self, path, mime):
        size = os.path.getsize(path)
        start, end, code = 0, size - 1, 200
        m = re.match(r'^bytes=(\d*)-(\d*)$', (self.headers.get('Range') or '').replace(' ', ''))
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:  # last N bytes
                start = max(0, size - int(m.group(2)))
            if start >= size or end < start:
                self.send_response(416)
                self.cors()
                self.send_header('Content-Range', 'bytes */%d' % size)
                self.end_headers()
                return
            code = 206
        stat = os.stat(path)
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', mime)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('ETag', '"%x-%x"' % (int(stat.st_mtime), size))
        self.send_header('Cache-Control', 'no-store')
        if code == 206:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.end_headers()
        if self.command == 'HEAD':
            return
        with open(path, 'rb') as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # ---- routes ----------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type, X-Token')
        self.send_header('Access-Control-Max-Age', '600')
        if self.headers.get('Access-Control-Request-Private-Network') == 'true':
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        self.do_GET()

    def do_GET(self):
        try:
            self.route()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # the clock stopped listening (page reloaded, Wi-Fi dropped)
        except Exception as e:
            say('error', self.path, e)
            try:
                self.reply(500, {'error': str(e)[:300]})
            except Exception:
                pass

    def route(self):
        if not self.allowed():
            return
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = url.path.rstrip('/') or '/'
        lib = self.library

        if path in ('/', '/health'):
            return self.reply(200, {'ok': True, 'yt_dlp': yt_dlp.version.__version__,
                                    'js_runtime': lib.js_runtime or 'none found'})

        if path == '/search':
            query = (q.get('q') or [''])[0].strip()
            kind = (q.get('type') or ['songs'])[0]
            if kind not in ('songs', 'videos'):
                kind = 'songs'
            if not query:
                return self.reply(400, {'error': 'Type something to search for'})
            started = time.time()
            results = lib.search(query, kind)
            say('search', repr(query), kind, len(results), 'results in %.1fs' % (time.time() - started))
            return self.reply(200, {'query': query, 'type': kind, 'results': results})

        vid = (q.get('id') or [''])[0]
        if path in ('/audio', '/art') or path.startswith(('/audio/', '/art/')):
            vid = path.split('/')[2] if path.count('/') >= 2 else vid
        if not VIDEO_ID.match(vid or ''):
            return self.reply(404 if path not in ('/download', '/status') else 400, {'error': 'Unknown song'})

        if path == '/download':
            thumb = (q.get('thumb') or [''])[0]
            return self.reply(200, lib.start(vid, thumb))
        if path == '/status':
            return self.reply(200, lib.status(vid))
        if path.startswith('/audio/'):
            file = lib.audio_file(vid)
            if not file:
                return self.reply(404, {'error': 'Not downloaded yet'})
            return self.send_file(file, AUDIO_TYPES.get(os.path.splitext(file)[1].lower(), 'application/octet-stream'))
        if path.startswith('/art/'):
            file = lib.art_file(vid)
            if not os.path.isfile(file):
                lib.fetch_art(vid, '')
            if not os.path.isfile(file):
                return self.reply(404, {'error': 'No artwork'})
            return self.send_file(file, 'image/jpeg')
        return self.reply(404, {'error': 'Not found'})


def pick_js_runtime(wanted):
    if wanted:
        return wanted
    for name in ('deno', 'node', 'bun', 'quickjs'):
        if shutil.which(name):
            return name
    return ''


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # song titles in Gujarati etc.
    except Exception:
        pass
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description='Clockadashi song server: YouTube Music search + yt-dlp downloads')
    ap.add_argument('--host', default='127.0.0.1', help='127.0.0.1 = this device only (default); 0.0.0.0 = whole network')
    ap.add_argument('--port', type=int, default=8790)
    ap.add_argument('--dir', default=os.path.join(here, 'downloads'), help='where downloaded songs are kept')
    ap.add_argument('--origin', action='append', default=[], help='extra page address allowed to use the server (repeatable)')
    ap.add_argument('--token', default=os.environ.get('CLOCKADASHI_TOKEN', ''), help='require this token (recommended with --host 0.0.0.0)')
    ap.add_argument('--js-runtime', default='', help='deno | node | bun | quickjs (default: first one found)')
    args = ap.parse_args()

    os.makedirs(args.dir, exist_ok=True)
    runtime = pick_js_runtime(args.js_runtime)
    Handler.library = Library(args.dir, runtime)
    Handler.origins = set(DEFAULT_ORIGINS + args.origin)
    Handler.token = args.token

    ThreadingHTTPServer.daemon_threads = True
    # On Windows, address reuse lets a second server silently share a busy port; fail loudly instead.
    ThreadingHTTPServer.allow_reuse_address = os.name != 'nt'
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        sys.exit('Port %d is already in use (%s). Start with --port and another number.' % (args.port, e.strerror))

    say('Clockadashi song server on http://%s:%d' % (args.host, args.port))
    say('yt-dlp', yt_dlp.version.__version__, '| JavaScript runtime:', runtime or 'NONE - install Deno or Node.js')
    say('songs saved in', args.dir)
    say('pages allowed:', ', '.join(sorted(Handler.origins)))
    if args.host not in ('127.0.0.1', 'localhost') and not args.token:
        say('warning: reachable from the network without --token')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        say('stopped')


if __name__ == '__main__':
    main()
