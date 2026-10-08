package boo.nehal.panel;

import android.content.Context;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The song server for the clock's Search tab, on the panel itself (http://localhost:8790), so
 * no computer, Python, yt-dlp, Node.js or adb tunnel is needed. Same API as server/ytdl_server.py:
 *   GET  /health                     what this is
 *   GET  /search?q=...&type=songs    YouTube Music results (type: songs | videos)
 *   POST /download?id=ID&thumb=URL   start (or join) a download
 *   GET  /status?id=ID               none / queued / downloading (progress 0..1) / ready / error
 *   GET  /audio/ID                   the audio file (supports Range)
 *   GET  /art/ID                     the artwork (jpg)
 *
 * Nothing is signed in. Search is YouTube Music's own web API, as the ytmusicapi library uses it.
 * Audio comes from YouTube's player API as its visionOS app asks for it: that client gets direct
 * links with no JavaScript challenge and no proof-of-origin token (yt-dlp's own default, Oct 2026).
 * The one extra it needs is a visitor ID, read from the YouTube home page like a browser would.
 * YouTube changes these things now and then; when downloads start failing, compare with
 * yt-dlp's current INNERTUBE_CLIENTS (yt_dlp/extractor/youtube/_base.py).
 */
final class SongServer {
  static final int PORT = 8790;
  static final String TAG = KeeperService.TAG;

  // YouTube's player API, as its visionOS app (from yt-dlp's client table)
  static final String VISION_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 "
      + "(KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  static final String VISION_NAME = "VISIONOS", VISION_VERSION = "1.02", VISION_ID = "101";
  // YouTube Music search filters (ytmusicapi's get_search_params)
  static final String PARAMS_SONGS = "EgWKAQIIAWoMEA4QChADEAQQCRAF";
  static final String PARAMS_VIDEOS = "EgWKAQIQAWoMEA4QChADEAQQCRAF";
  static final String WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

  static final int PIECE = 2 * 1024 * 1024;  // download in pieces: resumable, and YouTube throttles big ranges
  static final Pattern VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
  static final String[] EXTS = { ".m4a", ".webm" };

  private final File dir;
  private final Map<String, JSONObject> jobs = new HashMap<>();
  private final Semaphore slots = new Semaphore(2);  // two downloads at a time
  private String visitorData;
  private long visitorAt;

  SongServer(Context c) {
    dir = new File(c.getFilesDir(), "songs");
    dir.mkdirs();
  }

  void start() {
    Thread t = new Thread(() -> {
      while (true) {
        try (ServerSocket server = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"))) {
          Log.i(TAG, "song server on http://localhost:" + PORT);
          while (true) {
            Socket s = server.accept();
            new Thread(() -> handle(s), "songs-http").start();
          }
        } catch (Exception e) {
          Log.w(TAG, "song server (port busy? an adb reverse tunnel to a computer would hold it)", e);
          try { Thread.sleep(10000); } catch (InterruptedException ie) { return; }
        }
      }
    }, "songs-server");
    t.setDaemon(true);
    t.start();
  }

  /* ---- Search ------------------------------------------------------------------- */
  JSONArray search(String query, String kind) throws Exception {
    JSONObject client = new JSONObject().put("clientName", "WEB_REMIX")
        .put("clientVersion", "1." + new SimpleDateFormat("yyyyMMdd", Locale.ROOT).format(new Date()) + ".01.00")
        .put("hl", "en");
    JSONObject body = new JSONObject().put("context", new JSONObject().put("client", client))
        .put("query", query).put("params", "videos".equals(kind) ? PARAMS_VIDEOS : PARAMS_SONGS);
    Map<String, String> h = new HashMap<>();
    h.put("User-Agent", WEB_UA);
    h.put("Origin", "https://music.youtube.com");
    JSONObject data = postJson("https://music.youtube.com/youtubei/v1/search?prettyPrint=false", body, h);

    List<JSONObject> items = new ArrayList<>();
    collect(data, "musicResponsiveListItemRenderer", items);
    JSONArray out = new JSONArray();
    for (JSONObject it : items) {
      JSONObject pid = it.optJSONObject("playlistItemData");
      String vid = pid == null ? "" : pid.optString("videoId");
      JSONArray cols = it.optJSONArray("flexColumns");
      if (!VIDEO_ID.matcher(vid).matches() || cols == null || cols.length() == 0) continue;
      String title = runsText(column(cols, 0));
      List<String> artists = new ArrayList<>();
      String album = "";
      int duration = 0;
      JSONArray meta = column(cols, 1);
      for (int i = 0; meta != null && i < meta.length(); i++) {
        JSONObject r = meta.getJSONObject(i);
        String text = r.optString("text"), page = pageType(r);
        if (page.equals("MUSIC_PAGE_TYPE_ARTIST") || page.equals("MUSIC_PAGE_TYPE_USER_CHANNEL")) artists.add(text);
        else if (page.equals("MUSIC_PAGE_TYPE_ALBUM")) album = text;
        else if (text.matches("\\d+(:\\d\\d)+")) duration = seconds(text);
      }
      if (artists.isEmpty() && meta != null && meta.length() > 0) artists.add(meta.getJSONObject(0).optString("text").trim());
      out.put(new JSONObject()
          .put("id", vid)
          .put("kind", "videos".equals(kind) ? "video" : "song")
          .put("title", title)
          .put("artist", String.join(", ", artists))
          .put("album", album)
          .put("duration", duration)
          .put("thumb", bigThumb(it))
          .put("saved", audioFile(vid) != null));
    }
    return out;
  }

  private static void collect(Object o, String key, List<JSONObject> into) {
    if (o instanceof JSONObject) {
      JSONObject j = (JSONObject) o;
      JSONObject hit = j.optJSONObject(key);
      if (hit != null) into.add(hit);
      for (java.util.Iterator<String> k = j.keys(); k.hasNext(); ) collect(j.opt(k.next()), key, into);
    } else if (o instanceof JSONArray) {
      JSONArray a = (JSONArray) o;
      for (int i = 0; i < a.length(); i++) collect(a.opt(i), key, into);
    }
  }

  private static JSONArray column(JSONArray cols, int i) {
    if (i >= cols.length()) return null;
    JSONObject c = cols.optJSONObject(i);
    c = c == null ? null : c.optJSONObject("musicResponsiveListItemFlexColumnRenderer");
    c = c == null ? null : c.optJSONObject("text");
    return c == null ? null : c.optJSONArray("runs");
  }

  private static String runsText(JSONArray runs) {
    StringBuilder b = new StringBuilder();
    for (int i = 0; runs != null && i < runs.length(); i++) b.append(runs.optJSONObject(i).optString("text"));
    return b.toString();
  }

  private static String pageType(JSONObject run) {
    JSONObject e = run.optJSONObject("navigationEndpoint");
    e = e == null ? null : e.optJSONObject("browseEndpoint");
    e = e == null ? null : e.optJSONObject("browseEndpointContextSupportedConfigs");
    e = e == null ? null : e.optJSONObject("browseEndpointContextMusicConfig");
    return e == null ? "" : e.optString("pageType");
  }

  /** Largest thumbnail; YouTube Music's square art resized to 544 px (as the Python server did). */
  private static String bigThumb(JSONObject item) {
    JSONObject t = item.optJSONObject("thumbnail");
    t = t == null ? null : t.optJSONObject("musicThumbnailRenderer");
    t = t == null ? null : t.optJSONObject("thumbnail");
    JSONArray list = t == null ? null : t.optJSONArray("thumbnails");
    if (list == null || list.length() == 0) return "";
    String url = "";
    int best = -1;
    for (int i = 0; i < list.length(); i++) {
      JSONObject th = list.optJSONObject(i);
      if (th.optInt("width") > best) { best = th.optInt("width"); url = th.optString("url"); }
    }
    return url.replaceAll("=w\\d+-h\\d+(-[^/?#]*)?$", "=w544-h544-l90-rj");
  }

  private static int seconds(String text) {
    int total = 0;
    for (String p : text.split(":")) total = total * 60 + Integer.parseInt(p);
    return total;
  }

  /* ---- Files -------------------------------------------------------------------- */
  File audioFile(String vid) {
    for (String ext : EXTS) {
      File f = new File(dir, vid + ext);
      if (f.isFile()) return f;
    }
    return null;
  }

  private File artFile(String vid) { return new File(dir, vid + ".jpg"); }

  /** The artwork next to the audio; falls back to YouTube's own thumbnails. */
  private void fetchArt(String vid, String url) {
    File target = artFile(vid);
    if (target.isFile()) return;
    for (String candidate : new String[] { url, "https://i.ytimg.com/vi/" + vid + "/hq720.jpg",
        "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg" }) {
      if (candidate == null || !candidate.startsWith("https://")) continue;
      try {
        HttpURLConnection c = (HttpURLConnection) new URL(candidate).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setRequestProperty("User-Agent", WEB_UA);
        if (c.getResponseCode() == 200) {
          File part = new File(target.getPath() + ".part");
          try (InputStream in = c.getInputStream(); OutputStream o = new FileOutputStream(part)) { copy(in, o); }
          if (part.renameTo(target)) return;
        }
      } catch (Exception e) {
        Log.w(TAG, "artwork " + vid + " failed from " + candidate);
      }
    }
  }

  /* ---- Downloads ---------------------------------------------------------------- */
  synchronized JSONObject status(String vid) throws Exception {
    JSONObject job = jobs.get(vid);
    if (job != null) return new JSONObject(job.toString());
    File f = audioFile(vid);
    return f != null ? ready(vid, f) : new JSONObject().put("id", vid).put("state", "none");
  }

  private static JSONObject ready(String vid, File f) throws Exception {
    return new JSONObject().put("id", vid).put("state", "ready").put("progress", 1.0)
        .put("size", f.length()).put("type", f.getName().endsWith(".m4a") ? "audio/mp4" : "audio/webm");
  }

  synchronized JSONObject start(String vid, String thumb) throws Exception {
    JSONObject job = jobs.get(vid);
    String state = job == null ? "" : job.optString("state");
    if (state.equals("queued") || state.equals("downloading") || state.equals("ready")) return new JSONObject(job.toString());
    File f = audioFile(vid);
    if (f != null) {
      jobs.put(vid, ready(vid, f));
      if (!artFile(vid).isFile()) new Thread(() -> fetchArt(vid, thumb)).start();
      return ready(vid, f);
    }
    job = new JSONObject().put("id", vid).put("state", "queued").put("progress", 0.0);
    jobs.put(vid, job);
    new Thread(() -> download(vid, thumb), "song-" + vid).start();
    return new JSONObject(job.toString());
  }

  private synchronized void update(String vid, JSONObject fields) {
    jobs.put(vid, fields);
  }

  private void download(String vid, String thumb) {
    try { slots.acquire(); } catch (InterruptedException e) { return; }
    long started = System.currentTimeMillis();
    String message = "download failed";
    try {
      update(vid, new JSONObject().put("id", vid).put("state", "downloading").put("progress", 0.0));
      fetchArt(vid, thumb);
      // A link can be refused now and then; a fresh lookup gets new ones, so retry a couple of times.
      for (int attempt = 1; attempt <= 3; attempt++) {
        try {
          File f = fetchAudio(vid, attempt > 1);
          update(vid, ready(vid, f));
          Log.i(TAG, String.format(Locale.ROOT, "song %s ready: %.1f MB in %d s", vid, f.length() / 1048576.0,
              (System.currentTimeMillis() - started) / 1000));
          return;
        } catch (Unplayable e) {
          message = e.getMessage();
          break;
        } catch (Exception e) {
          message = String.valueOf(e.getMessage());
          Log.w(TAG, "song " + vid + " attempt " + attempt + ": " + message);
          Thread.sleep(4000L * attempt);
        }
      }
      update(vid, new JSONObject().put("id", vid).put("state", "error").put("error", message));
    } catch (Exception e) {
      Log.w(TAG, "song " + vid, e);
    } finally {
      slots.release();
    }
  }

  /** The video can't be had at all (private, removed, region, age...): don't retry. */
  static final class Unplayable extends Exception {
    Unplayable(String m) { super(m); }
  }

  private File fetchAudio(String vid, boolean freshVisitor) throws Exception {
    JSONObject p = player(vid, freshVisitor);
    JSONObject ps = p.optJSONObject("playabilityStatus");
    String status = ps == null ? "" : ps.optString("status");
    if (status.equals("LOGIN_REQUIRED") && !freshVisitor) p = player(vid, true);  // stale visitor ID
    ps = p.optJSONObject("playabilityStatus");
    status = ps == null ? "" : ps.optString("status");
    if (!status.equals("OK")) {
      String reason = ps == null ? "" : ps.optString("reason");
      if (status.equals("UNPLAYABLE") || status.equals("ERROR") || status.equals("AGE_CHECK_REQUIRED"))
        throw new Unplayable(reason.isEmpty() ? "YouTube says this can't be played" : reason);
      throw new IOException("YouTube said " + status + (reason.isEmpty() ? "" : ": " + reason));
    }

    // m4a (AAC 128k) plays everywhere; else Opus in WebM; else the best audio there is
    JSONArray formats = p.getJSONObject("streamingData").getJSONArray("adaptiveFormats");
    JSONObject pick = null;
    int pickRank = -1;
    for (int i = 0; i < formats.length(); i++) {
      JSONObject f = formats.getJSONObject(i);
      if (!f.optString("mimeType").startsWith("audio/") || !f.has("url")) continue;
      int itag = f.optInt("itag");
      int rank = itag == 140 ? 3_000_000 : itag == 251 ? 2_000_000 : f.optInt("bitrate");
      if (rank > pickRank) { pickRank = rank; pick = f; }
    }
    if (pick == null) throw new IOException("YouTube gave no direct audio links (they may have changed the API)");
    String ext = pick.optString("mimeType").startsWith("audio/mp4") ? ".m4a" : ".webm";
    long total = pick.optLong("contentLength", -1);
    String url = pick.getString("url");

    File part = new File(dir, vid + ext + ".part");
    long have = part.isFile() ? part.length() : 0;  // resume after a Wi-Fi drop
    try (FileOutputStream out = new FileOutputStream(part, true)) {
      while (total < 0 || have < total) {
        long end = have + PIECE - 1;
        if (total > 0) end = Math.min(end, total - 1);
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", VISION_UA);
        c.setRequestProperty("Range", "bytes=" + have + "-" + end);
        int code = c.getResponseCode();
        if (code == 416 && total < 0) break;                 // unknown length: past the end
        if (code != 206 && code != 200) throw new IOException("audio link answered HTTP " + code);
        long got = 0;
        try (InputStream in = c.getInputStream()) {
          byte[] buf = new byte[65536];
          int n;
          while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); got += n; }
        }
        have += got;
        if (got == 0) break;
        if (total > 0) {
          update(vid, new JSONObject().put("id", vid).put("state", "downloading")
              .put("progress", Math.min(0.99, Math.round(have * 1000.0 / total) / 1000.0)));
        }
        if (total < 0 && got < PIECE) break;
      }
    }
    File done = new File(dir, vid + ext);
    if (!part.renameTo(done)) throw new IOException("could not save " + done.getName());
    return done;
  }

  /** YouTube's player API as the visionOS app: direct audio links, no JavaScript needed. */
  private JSONObject player(String vid, boolean freshVisitor) throws Exception {
    String vd = visitorData(freshVisitor);
    JSONObject client = new JSONObject().put("clientName", VISION_NAME).put("clientVersion", VISION_VERSION)
        .put("deviceMake", "Apple").put("deviceModel", "RealityDevice17,1").put("osName", "visionOS")
        .put("osVersion", "26.5.23O471").put("hl", "en").put("userAgent", VISION_UA).put("visitorData", vd);
    JSONObject body = new JSONObject().put("context", new JSONObject().put("client", client))
        .put("videoId", vid).put("contentCheckOk", true).put("racyCheckOk", true);
    Map<String, String> h = new HashMap<>();
    h.put("User-Agent", VISION_UA);
    h.put("X-YouTube-Client-Name", VISION_ID);
    h.put("X-YouTube-Client-Version", VISION_VERSION);
    h.put("Origin", "https://www.youtube.com");
    h.put("X-Goog-Visitor-Id", vd);
    return postJson("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", body, h);
  }

  /** An anonymous visitor ID from the YouTube home page, kept for a few hours. */
  private synchronized String visitorData(boolean fresh) throws Exception {
    if (!fresh && visitorData != null && System.currentTimeMillis() - visitorAt < 6 * 3600_000L) return visitorData;
    HttpURLConnection c = (HttpURLConnection) new URL("https://www.youtube.com/").openConnection();
    c.setConnectTimeout(15000);
    c.setReadTimeout(20000);
    c.setRequestProperty("User-Agent", VISION_UA);
    c.setRequestProperty("Accept-Language", "en");
    String page;
    try (InputStream in = c.getInputStream()) { page = readAll(in); }
    Matcher m = Pattern.compile("\"VISITOR_DATA\":\"([^\"]+)\"").matcher(page);
    if (!m.find()) throw new IOException("no visitor ID on the YouTube page");
    visitorData = m.group(1);
    visitorAt = System.currentTimeMillis();
    return visitorData;
  }

  private static JSONObject postJson(String url, JSONObject body, Map<String, String> headers) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    c.setConnectTimeout(15000);
    c.setReadTimeout(20000);
    c.setRequestMethod("POST");
    c.setDoOutput(true);
    c.setRequestProperty("Content-Type", "application/json");
    for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
    try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
    int code = c.getResponseCode();
    InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
    String text = in == null ? "" : readAll(in);
    if (code >= 400) throw new IOException("YouTube answered HTTP " + code);
    return new JSONObject(text);
  }

  /* ---- HTTP --------------------------------------------------------------------- */
  private void handle(Socket s) {
    try (Socket sock = s) {
      sock.setSoTimeout(30000);
      InputStream in = sock.getInputStream();
      OutputStream out = sock.getOutputStream();
      String head = readHead(in);
      if (head == null) return;
      String[] lines = head.split("\r\n");
      String[] req = lines[0].split(" ");
      if (req.length < 2) return;
      String method = req[0], target = req[1], path = target, query = "";
      int q = target.indexOf('?');
      if (q >= 0) { path = target.substring(0, q); query = target.substring(q + 1); }
      Map<String, String> h = new HashMap<>();
      for (String l : lines) {
        int c = l.indexOf(':');
        if (c > 0) h.put(l.substring(0, c).trim().toLowerCase(Locale.ROOT), l.substring(c + 1).trim());
      }
      String origin = h.getOrDefault("origin", "");
      boolean allowed = origin.isEmpty();
      for (String o : KeeperService.ORIGINS) if (o.equals(origin)) allowed = true;

      if (method.equals("OPTIONS")) {
        out.write(("HTTP/1.1 204 No Content\r\n" + cors(origin, allowed)
            + "Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\n"
            + "Access-Control-Allow-Headers: Range, Content-Type, X-Token\r\nAccess-Control-Max-Age: 600\r\n"
            + "Access-Control-Allow-Private-Network: true\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .getBytes(StandardCharsets.ISO_8859_1));
        return;
      }
      if (!allowed) { json(out, origin, false, 403, new JSONObject().put("error", "This page (" + origin + ") is not allowed")); return; }
      boolean head_ = method.equals("HEAD");
      Map<String, String> args = parseQuery(query);
      while (path.length() > 1 && path.endsWith("/")) path = path.substring(0, path.length() - 1);

      if (path.equals("/") || path.equals("/health")) {
        json(out, origin, head_, 200, new JSONObject().put("ok", true).put("engine", "panel app")
            .put("client", "visionos").put("songs", dir.list() == null ? 0 : dir.list().length));
        return;
      }
      if (path.equals("/search")) {
        String query_ = args.getOrDefault("q", "").trim();
        String kind = "videos".equals(args.get("type")) ? "videos" : "songs";
        if (query_.isEmpty()) { json(out, origin, head_, 400, new JSONObject().put("error", "Type something to search for")); return; }
        long t0 = System.currentTimeMillis();
        try {
          JSONArray results = search(query_, kind);
          Log.i(TAG, "search '" + query_ + "' " + kind + ": " + results.length() + " in " + (System.currentTimeMillis() - t0) + " ms");
          json(out, origin, head_, 200, new JSONObject().put("query", query_).put("type", kind).put("results", results));
        } catch (Exception e) {
          Log.w(TAG, "search failed", e);
          json(out, origin, head_, 502, new JSONObject().put("error", "YouTube Music search failed: " + e.getMessage()));
        }
        return;
      }
      String vid = args.getOrDefault("id", "");
      if (path.startsWith("/audio/") || path.startsWith("/art/")) vid = path.substring(path.lastIndexOf('/') + 1);
      if (!VIDEO_ID.matcher(vid).matches()) {
        boolean jobPath = path.equals("/download") || path.equals("/status");
        json(out, origin, head_, jobPath ? 400 : 404, new JSONObject().put("error", "Unknown song"));
        return;
      }
      if (path.equals("/download")) { json(out, origin, head_, 200, start(vid, args.getOrDefault("thumb", ""))); return; }
      if (path.equals("/status")) { json(out, origin, head_, 200, status(vid)); return; }
      if (path.startsWith("/audio/")) {
        File f = audioFile(vid);
        if (f == null) json(out, origin, head_, 404, new JSONObject().put("error", "Not downloaded yet"));
        else sendFile(out, origin, f, f.getName().endsWith(".m4a") ? "audio/mp4" : "audio/webm", h.get("range"), head_);
        return;
      }
      if (path.startsWith("/art/")) {
        File f = artFile(vid);
        if (!f.isFile()) fetchArt(vid, "");
        if (!f.isFile()) json(out, origin, head_, 404, new JSONObject().put("error", "No artwork"));
        else sendFile(out, origin, f, "image/jpeg", h.get("range"), head_);
        return;
      }
      json(out, origin, head_, 404, new JSONObject().put("error", "Not found"));
    } catch (Exception e) {
      Log.w(TAG, "song server request", e);
    }
  }

  private static String cors(String origin, boolean allowed) {
    if (origin.isEmpty() || !allowed) return "";
    return "Access-Control-Allow-Origin: " + origin + "\r\nVary: Origin\r\n"
        + "Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, ETag\r\n";
  }

  private static void json(OutputStream out, String origin, boolean head, int code, JSONObject data) throws IOException {
    byte[] body = data.toString().getBytes(StandardCharsets.UTF_8);
    out.write(("HTTP/1.1 " + code + " X\r\n" + cors(origin, true) + "Content-Type: application/json; charset=utf-8\r\n"
        + "Content-Length: " + body.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
        .getBytes(StandardCharsets.ISO_8859_1));
    if (!head) out.write(body);
    out.flush();
  }

  private static void sendFile(OutputStream out, String origin, File f, String mime, String range, boolean head)
      throws IOException {
    long size = f.length(), from = 0, to = size - 1;
    boolean partial = false;
    if (range != null) {
      Matcher m = Pattern.compile("^bytes=(\\d*)-(\\d*)$").matcher(range.replace(" ", ""));
      if (m.matches() && !(m.group(1).isEmpty() && m.group(2).isEmpty())) {
        if (!m.group(1).isEmpty()) {
          from = Long.parseLong(m.group(1));
          if (!m.group(2).isEmpty()) to = Math.min(Long.parseLong(m.group(2)), size - 1);
        } else {
          from = Math.max(0, size - Long.parseLong(m.group(2)));
        }
        if (from >= size || to < from) {
          out.write(("HTTP/1.1 416 X\r\n" + cors(origin, true) + "Content-Range: bytes */" + size
              + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
          return;
        }
        partial = true;
      }
    }
    StringBuilder b = new StringBuilder(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
    b.append(cors(origin, true)).append("Content-Type: ").append(mime).append("\r\nAccept-Ranges: bytes\r\n")
        .append("Content-Length: ").append(to - from + 1).append("\r\n")
        .append("ETag: \"").append(Long.toHexString(f.lastModified() / 1000)).append('-').append(Long.toHexString(size)).append("\"\r\n")
        .append("Cache-Control: no-store\r\n");
    if (partial) b.append("Content-Range: bytes ").append(from).append('-').append(to).append('/').append(size).append("\r\n");
    b.append("Connection: close\r\n\r\n");
    out.write(b.toString().getBytes(StandardCharsets.ISO_8859_1));
    if (!head) {
      try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
        raf.seek(from);
        byte[] buf = new byte[65536];
        long left = to - from + 1;
        while (left > 0) {
          int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
          if (n < 0) break;
          out.write(buf, 0, n);
          left -= n;
        }
      }
    }
    out.flush();
  }

  /* ---- Small helpers -------------------------------------------------------------- */
  private static Map<String, String> parseQuery(String q) throws Exception {
    Map<String, String> m = new HashMap<>();
    for (String pair : q.split("&")) {
      if (pair.isEmpty()) continue;
      int eq = pair.indexOf('=');
      String k = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), "UTF-8");
      String v = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
      if (!m.containsKey(k)) m.put(k, v);
    }
    return m;
  }

  private static String readAll(InputStream in) throws IOException {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    copy(in, b);
    return b.toString("UTF-8");
  }

  private static void copy(InputStream in, OutputStream out) throws IOException {
    byte[] buf = new byte[65536];
    int n;
    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
  }

  private static String readHead(InputStream in) throws IOException {
    StringBuilder b = new StringBuilder();
    int c, match = 0;
    while ((c = in.read()) != -1) {
      b.append((char) c);
      match = (c == '\r' && (match == 0 || match == 2)) || (c == '\n' && (match == 1 || match == 3)) ? match + 1 : 0;
      if (match == 4) return b.toString();
      if (b.length() > 16384) return null;
    }
    return null;
  }
}
