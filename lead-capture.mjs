// ApetureCodex — CTA lead capture
// Catches Revenue Scorecard + AI Visibility completions (whether or not they book)
// POST -> creates a Close lead with "CTA Lead - No Booking Yet" status, which
// auto-enrolls the lead in the "CTA No-Booking Follow-up" workflow.

const ALLOWED_ORIGINS = [
  "https://apeturecodex.com",
  "https://www.apeturecodex.com",
  "https://new-apeturecodex-site.webflow.io",
  "https://cheery-gingersnap-36bb09.netlify.app",
];

// Lead status that triggers the follow-up workflow in Close
const CTA_STATUS_ID = process.env.CTA_STATUS_ID || "stat_kD3EJtweIOIn3uMxSqshHNh5bVOxnNSyWZIeEzH1hi1";

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function normalizeUrl(u) {
  if (!u) return undefined;
  u = String(u).trim();
  if (!u) return undefined;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return undefined; }
}

function detectSource(p) {
  if (p.top_fixes || p.weakest || p.categories) return "Revenue Growth Scorecard";
  if (p.industry || p.goal || p.deal) return "AI Visibility Assessment";
  return "Website CTA";
}

function buildNote(p, source) {
  const lines = ["CTA LEAD — " + source + " (completed, no booking yet)"];
  if (p.score !== undefined) lines.push("Score: " + p.score);
  if (p.weakest) lines.push("Weakest area: " + p.weakest);
  if (Array.isArray(p.categories))
    lines.push("Category scores: " + p.categories.map(c => c.name + " " + c.pct + "/100").join(" · "));
  if (Array.isArray(p.top_fixes)) lines.push("Top ranked fixes: " + p.top_fixes.join(" / "));
  if (p.industry) lines.push("Industry: " + p.industry);
  if (p.deal) lines.push("Avg deal size: " + p.deal);
  if (p.goal) lines.push("Growth goal: " + p.goal);
  if (p.website) lines.push("Website: " + p.website);
  lines.push("Submitted: " + (p.ts || p.submittedAt || new Date().toISOString()));
  lines.push("", "Follow-up: enrolled in 'CTA No-Booking Follow-up' via lead status.");
  return lines.join("\n");
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors(origin) });

  let p;
  try { p = await req.json(); } catch { p = null; }
  if (!p || !p.email) {
    return new Response(JSON.stringify({ error: "missing email" }), { status: 400, headers: cors(origin) });
  }

  const key = process.env.CLOSE || process.env.CLOSE_API_KEY;
  if (!key) return new Response(JSON.stringify({ error: "close_not_configured" }), { status: 500, headers: cors(origin) });
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");
  const source = detectSource(p);

  try {
    const leadRes = await fetch("https://api.close.com/api/v1/lead/", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: p.company || p.name || p.email,
        status_id: CTA_STATUS_ID,
        url: normalizeUrl(p.website),
        contacts: [{ name: p.name || p.email, emails: [{ email: p.email, type: "office" }] }],
      }),
    });
    if (!leadRes.ok) {
      const body = await leadRes.text().catch(() => "");
      throw new Error("close lead " + leadRes.status + " " + body.slice(0, 200));
    }
    const lead = await leadRes.json();
    await fetch("https://api.close.com/api/v1/activity/note/", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: lead.id, note: buildNote(p, source) }),
    }).catch(() => {});
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors(origin) });
  } catch (e) {
    console.log("LEAD_CAPTURE_ERR", String(e).slice(0, 300));
    return new Response(JSON.stringify({ error: "capture_failed" }), { status: 502, headers: cors(origin) });
  }
}

export const config = { path: "/api/lead-capture" };
