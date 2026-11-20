/**
 * Generated-JS fragment for the capture script: per-page request tracking,
 * Retry-After parsing, and reuse of the desktop load's API responses on the
 * other viewports. A returned string (like `heuristicsProbeScript`) because
 * the script runs under the target repo's Node, not flow's Bun. It is embedded
 * in a String.raw template, so the JS must never contain a backtick or "${".
 */
export function captureNetworkScript(): string {
  return String.raw`
var MAX_FAILURES = 20;
var MAX_URL = 300;
var TRACKED = { document: 1, fetch: 1, xhr: 1 };
var DROPPED_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

function hostPath(u) {
  try {
    var p = new URL(u);
    return (p.host + p.pathname).slice(0, MAX_URL);
  } catch (e) {
    return String(u).slice(0, MAX_URL);
  }
}

function capFailures(list) {
  return list
    .map(function (f) { return { url: String(f.url).slice(0, MAX_URL), status: f.status, count: f.count }; })
    .sort(function (a, b) {
      return (b.status === 429) - (a.status === 429) || b.count - a.count;
    })
    .slice(0, MAX_FAILURES);
}

function retryAfterMs(value, minMs, maxMs) {
  var blank = value === undefined || value === null || String(value).trim() === "";
  var n = blank ? NaN : Number(value);
  var ms = isFinite(n) && n >= 0 ? n * 1000 : minMs;
  return Math.min(maxMs, Math.max(minMs, ms));
}

function track(page) {
  var hits = new Map();
  var fails = new Map();
  var seq = 0;
  function hit(req) {
    var key = req.method() + " " + req.url();
    var h = hits.get(key) || { hp: hostPath(req.url()), n: 0 };
    h.n++;
    hits.set(key, h);
    return key;
  }
  page.on("response", function (res) {
    var req = res.request();
    if (!TRACKED[req.resourceType()]) return;
    var key = hit(req);
    var status = res.status();
    if (status >= 400) {
      fails.set(key, { status: status, retryAfter: res.headers()["retry-after"], seq: seq++ });
    } else if (status >= 200 && status < 300) {
      fails.delete(key);
    }
  });
  page.on("requestfailed", function (req) {
    if (!TRACKED[req.resourceType()]) return;
    var f = req.failure();
    if (f && String(f.errorText).indexOf("net::ERR_ABORTED") !== -1) return;
    fails.set(hit(req), { status: 0, seq: seq++ });
  });
  return {
    failures: function () {
      var byPath = new Map();
      fails.forEach(function (f, key) {
        var hp = hits.get(key).hp;
        var cur = byPath.get(hp) || { url: hp, status: 0, count: 1, seq: -1 };
        hits.forEach(function (h) {
          if (h.hp === hp) cur.count = Math.max(cur.count, h.n);
        });
        if (f.seq > cur.seq) { cur.seq = f.seq; cur.status = f.status; }
        byPath.set(hp, cur);
      });
      return capFailures(Array.from(byPath.values()));
    },
    reset: function () { hits.clear(); fails.clear(); },
    sawStatus: function (statuses) {
      var found = null;
      fails.forEach(function (f) {
        if (!found && statuses.indexOf(f.status) !== -1) found = f;
      });
      return found;
    },
  };
}

function recordResponses(page, baseHost) {
  var map = new Map();
  var pending = [];
  page.on("response", function (res) {
    var req = res.request();
    var type = req.resourceType();
    if (type !== "fetch" && type !== "xhr") return;
    var status = res.status();
    if (status < 200 || status > 299) return;
    if (new URL(req.url()).host !== baseHost) return;
    var key = req.method() + " " + req.url() + " " + (req.postData() || "");
    var headers = {};
    var raw = res.headers();
    Object.keys(raw).forEach(function (h) {
      if (DROPPED_HEADERS.indexOf(h) === -1) headers[h] = raw[h];
    });
    pending.push(
      res.body().then(
        function (body) { map.set(key, { status: status, headers: headers, body: body }); },
        function () {},
      ),
    );
  });
  return { map: map, settled: function () { return Promise.all(pending); } };
}

async function replayResponses(ctx, map) {
  await ctx.route("**/*", function (route) {
    var req = route.request();
    var hit = map.get(req.method() + " " + req.url() + " " + (req.postData() || ""));
    return hit ? route.fulfill(hit) : route.continue();
  });
}
`;
}
