package boo.nehal.panel;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The clock web app, served by the panel itself on http://localhost:8642, so it opens with no
 * internet and doesn't depend on GitHub Pages being up.
 *
 * Files live in app storage. They start as the copy bundled in this APK (assets/site) and are
 * replaced only when https://clock.nehal.boo has published a newer one (its Last-Modified is
 * later than ours), so pushing to GitHub still updates the panel. Songs and artwork are fetched
 * from there the first time they're asked for, streamed straight through, and kept.
 * The page's connection check (?probe=) is passed through, so "Offline" still shows when the
 * internet is down.
 */
final class LocalSite {
  static final int PORT = 8642;
  static final String UPSTREAM = "https://clock.nehal.boo";
  static final int UPSTREAM_TIMEOUT_MS = 2500;  // app files: after this, serve the copy we have
  private static final String TAG = KeeperService.TAG;

  private final Context ctx;
  private final File root;
  private final long bundledTime;  // when this APK was installed: the bundled files count as this new
  private final Set<String> downloading = new HashSet<>();

  LocalSite(Context c) {
    ctx = c;
    root = new File(c.getFilesDir(), "site");
    long t;
    try { t = c.getPackageManager().getPackageInfo(c.getPackageName(), 0).lastUpdateTime; }
    catch (Exception e) { t = 0; }
    bundledTime = t;
  }

  void start() {
    Thread t = new Thread(() -> {
      unpackBundled();
      while (true) {
        try (ServerSocket server = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"))) {
          Log.i(TAG, "clock site on http://localhost:" + PORT);
          while (true) {
            Socket s = server.accept();
            new Thread(() -> handle(s), "site-http").start();
          }
        } catch (Exception e) {
          Log.w(TAG, "site server", e);
          try { Thread.sleep(5000); } catch (InterruptedException ie) { return; }
        }
      }
    }, "site-server");
    t.setDaemon(true);
    t.start();
  }

  /* ---- The bundled copy ------------------------------------------------------ */
  private void unpackBundled() {
    try { unpack(ctx.getAssets(), "site", ""); } catch (Exception e) { Log.w(TAG, "unpack", e); }
  }

  private void unpack(AssetManager am, String assetDir, String rel) throws Exception {
    String[] names = am.list(assetDir);
    if (names == null) return;
    for (String n : names) {
      String a = assetDir + "/" + n, r = rel + "/" + n;
      String[] sub = am.list(a);
      if (sub != null && sub.length > 0) { unpack(am, a, r); continue; }
      File f = new File(root, r);
      if (f.exists() && modified(f) >= bundledTime) continue;  // already this copy, or a newer one
      try (InputStream in = am.open(a)) { store(f, in, bundledTime); }
    }
  }

  /* ---- Requests ----------------------------------------------------------------- */
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
      String method = req[0];
      String path = req[1], query = "";
      int q = path.indexOf('?');
      if (q >= 0) { query = path.substring(q + 1); path = path.substring(0, q); }
      path = java.net.URLDecoder.decode(path, "UTF-8");
      if (path.endsWith("/")) path += "index.html";
      String range = null;
      for (String l : lines) {
        int c = l.indexOf(':');
        if (c > 0 && l.substring(0, c).trim().equalsIgnoreCase("range")) range = l.substring(c + 1).trim();
      }
      boolean head_ = method.equals("HEAD");
      if (!method.equals("GET") && !head_) { status(out, 405); return; }
      if (path.contains("..") || !path.startsWith("/")) { status(out, 400); return; }

      if (query.contains("probe=")) { probe(out, path); return; }
      File f = new File(root, path);
      if (isMedia(path)) {
        if (head_) refreshMediaInfo(path, f);
        if (f.isFile()) { serve(out, f, path, range, head_); return; }
        streamThrough(out, path, range, head_);
        fetchInBackground(path, f);
        return;
      }
      revalidate(path, f);
      if (f.isFile()) serve(out, f, path, range, head_);
      else status(out, 404);
    } catch (Exception e) {
      Log.w(TAG, "site request", e);
    }
  }

  /** App files: take the published copy if it is newer than ours; on any trouble keep ours. */
  private void revalidate(String path, File f) {
    HttpURLConnection c = null;
    try {
      c = open(path, "GET");
      long have = f.isFile() ? modified(f) : 0;
      if (have > 0) c.setIfModifiedSince(have);
      int code = c.getResponseCode();
      long theirs = c.getLastModified();
      if (code == 200 && (have == 0 || theirs > have)) {
        try (InputStream in = c.getInputStream()) { store(f, in, theirs > 0 ? theirs : System.currentTimeMillis()); }
        if (have > 0) Log.i(TAG, "site: newer " + path + " from " + UPSTREAM);
      }
    } catch (Exception offlineOrSlow) {
      // keep serving our copy
    } finally {
      if (c != null) c.disconnect();
    }
  }

  /** The page's "are we online?" check goes to the real server. */
  private void probe(OutputStream out, String path) throws Exception {
    int code;
    try {
      HttpURLConnection c = open(path, "HEAD");
      code = c.getResponseCode();
      c.disconnect();
    } catch (Exception e) {
      code = 503;
    }
    status(out, code);
  }

  /** A song's HEAD (the player checks for replaced songs): if the published one is newer, drop ours. */
  private void refreshMediaInfo(String path, File f) {
    if (!f.isFile()) return;
    try {
      HttpURLConnection c = open(path, "HEAD");
      if (c.getResponseCode() == 200 && c.getLastModified() > modified(f)) {
        Log.i(TAG, "site: " + path + " was replaced upstream");
        delete(f);
      }
      c.disconnect();
    } catch (Exception ignored) {}
  }

  /** Not kept yet: pass the request (with its Range) straight through to the real server. */
  private void streamThrough(OutputStream out, String path, String range, boolean head) throws Exception {
    HttpURLConnection c;
    try {
      c = open(path, head ? "HEAD" : "GET");
      c.setReadTimeout(30000);
      if (range != null) c.setRequestProperty("Range", range);
      c.getResponseCode();
    } catch (Exception e) {
      status(out, 503);
      return;
    }
    int code = c.getResponseCode();
    StringBuilder h = new StringBuilder("HTTP/1.1 " + code + " X\r\n");
    for (String k : new String[] { "Content-Type", "Content-Length", "Content-Range", "Last-Modified", "ETag" }) {
      String v = c.getHeaderField(k);
      if (v != null) h.append(k).append(": ").append(v).append("\r\n");
    }
    h.append("Accept-Ranges: bytes\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n");
    out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
    if (!head && code < 400) {
      try (InputStream in = c.getInputStream()) { copy(in, out, Long.MAX_VALUE); }
    }
    out.flush();
    c.disconnect();
  }

  private void fetchInBackground(String path, File f) {
    synchronized (downloading) { if (!downloading.add(path)) return; }
    new Thread(() -> {
      HttpURLConnection c = null;
      try {
        c = open(path, "GET");
        c.setReadTimeout(60000);
        if (c.getResponseCode() == 200) {
          try (InputStream in = c.getInputStream()) { store(f, in, c.getLastModified()); }
          Log.i(TAG, "site: kept " + path);
        }
      } catch (Exception e) {
        Log.w(TAG, "site: could not keep " + path + ": " + e.getMessage());
      } finally {
        if (c != null) c.disconnect();
        synchronized (downloading) { downloading.remove(path); }
      }
    }, "site-fetch").start();
  }

  /* ---- Serving a kept file, with Range support (the player loads songs in 1 MB pieces) ---- */
  private void serve(OutputStream out, File f, String path, String range, boolean head) throws Exception {
    long len = f.length(), from = 0, to = len - 1;
    boolean partial = false;
    if (range != null && range.startsWith("bytes=") && !range.contains(",")) {
      String[] p = range.substring(6).split("-", -1);
      try {
        if (p[0].isEmpty()) { from = Math.max(0, len - Long.parseLong(p[1])); }
        else { from = Long.parseLong(p[0]); if (!p[1].isEmpty()) to = Math.min(len - 1, Long.parseLong(p[1])); }
        partial = true;
      } catch (NumberFormatException ignored) {}
      if (from >= len || from > to) {
        out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + len +
            "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        return;
      }
    }
    StringBuilder h = new StringBuilder(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
    h.append("Content-Type: ").append(type(path)).append("\r\n");
    h.append("Content-Length: ").append(to - from + 1).append("\r\n");
    if (partial) h.append("Content-Range: bytes ").append(from).append('-').append(to).append('/').append(len).append("\r\n");
    h.append("Accept-Ranges: bytes\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n");
    out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
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

  /* ---- Helpers --------------------------------------------------------------------- */
  private static HttpURLConnection open(String path, String method) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(UPSTREAM + path).openConnection();
    c.setRequestMethod(method);
    c.setConnectTimeout(UPSTREAM_TIMEOUT_MS);
    c.setReadTimeout(UPSTREAM_TIMEOUT_MS);
    c.setUseCaches(false);
    c.setInstanceFollowRedirects(true);
    return c;
  }

  /** Writes atomically (own temp file + rename) and remembers the copy's publish time. */
  private static void store(File f, InputStream in, long modified) throws Exception {
    File dir = f.getParentFile();
    if (dir != null) dir.mkdirs();
    File tmp = new File(f.getPath() + "." + Thread.currentThread().getId() + ".part");
    try (OutputStream o = new FileOutputStream(tmp)) { copy(in, o, Long.MAX_VALUE); }
    if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new Exception("rename failed: " + f); }
    f.setLastModified(modified > 0 ? modified : System.currentTimeMillis());
  }

  private static long modified(File f) { return f.lastModified(); }
  private static void delete(File f) { f.delete(); }

  private static void copy(InputStream in, OutputStream out, long max) throws Exception {
    byte[] buf = new byte[65536];
    int n;
    long total = 0;
    while (total < max && (n = in.read(buf)) > 0) { out.write(buf, 0, n); total += n; }
  }

  private static boolean isMedia(String path) {
    String p = path.toLowerCase(Locale.ROOT);
    return p.startsWith("/music/") || p.endsWith(".mp3") || p.endsWith(".m4a") || p.endsWith(".ogg");
  }

  private static final Map<String, String> TYPES = new HashMap<>();
  static {
    String[] t = { "html", "text/html; charset=utf-8", "css", "text/css; charset=utf-8",
        "js", "application/javascript; charset=utf-8", "json", "application/json; charset=utf-8",
        "csv", "text/csv; charset=utf-8", "txt", "text/plain; charset=utf-8", "png", "image/png",
        "jpg", "image/jpeg", "jpeg", "image/jpeg", "webp", "image/webp", "svg", "image/svg+xml",
        "ico", "image/x-icon", "woff2", "font/woff2", "mp3", "audio/mpeg", "m4a", "audio/mp4",
        "ogg", "audio/ogg", "webmanifest", "application/manifest+json" };
    for (int i = 0; i < t.length; i += 2) TYPES.put(t[i], t[i + 1]);
  }
  private static String type(String path) {
    int dot = path.lastIndexOf('.');
    String t = dot < 0 ? null : TYPES.get(path.substring(dot + 1).toLowerCase(Locale.ROOT));
    return t != null ? t : "application/octet-stream";
  }

  private static void status(OutputStream out, int code) throws Exception {
    out.write(("HTTP/1.1 " + code + " X\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
        .getBytes(StandardCharsets.ISO_8859_1));
    out.flush();
  }

  private static String readHead(InputStream in) throws Exception {
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
