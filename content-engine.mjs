// ApetureCodex — Content Engine preview generator
// POST { email, company, website, size, c1, c2, c3, icp }
// Returns { pillars: [...], competitor_note } and (optionally) pushes the lead to Close.

const ALLOWED_ORIGINS = [
  "https://apeturecodex.com",
  "https://www.apeturecodex.com",
  "https://new-apeturecodex-site.webflow.io",
];

const MODEL = process.env.MODEL || "claude-haiku-4-5";

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
  if (!u) return null;
  u = u.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return null; }
}

// Fetch a page and reduce it to readable text (capped)
async function fetchText(url, cap = 6000, timeoutMs = 5000) {
  const u = normalizeUrl(url);
  if (!u) return "";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ApetureCodexBot/1.0)" },
      redirect: "follow",
    });
    if (!res.ok) return "";
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, cap);
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

async function callClaude(payload, siteText, compTexts) {
  const compBlock = compTexts
    .map((c, i) => (c.text ? `COMPETITOR ${i + 1} (${c.name}):\n${c.text}` : `COMPETITOR ${i + 1} (${c.name}): (site not readable — use the name only)`))
    .join("\n\n");

  const prompt = `You are the research engine for ApetureCodex, a revenue consultancy. Build a PREVIEW of a "90-Day Content Engine" for a prospect.

METHODOLOGY (follow strictly):
- Prioritize the diagnostic language this prospect's exact buyer types into Google when the problem hurts — NOT high-volume category head terms.
- Prefer low-competition, high-intent wedge terms (size/stage wedges, comparison searches, "why is X happening" searches) over anything their competitors already dominate.
- Mine the competitor pages for the words the market uses, then find the gaps they are NOT covering.
- Every pillar must map to a plausible CTA that moves a reader toward revenue.
- Titles must be honest and specific. No clickbait, no hype words.

PROSPECT:
Company: ${payload.company}
Website text: ${siteText || "(site not readable)"}
Ideal customer (their words): ${payload.icp || "(not provided)"}
Company size: ${payload.size || "(not provided)"}

${compBlock}

Return ONLY valid JSON, no markdown fences, in exactly this shape:
{
  "pillars": [
    {
      "name": "short pillar name",
      "wedge_type": "Diagnostic wedge | Size & stage wedge | Comparison wedge | Category gap",
      "why_it_converts": "one sentence, specific to this prospect's buyer",
      "sample_titles": ["title 1", "title 2"],
      "cta": "what each piece asks the reader to do next, one short phrase"
    }
  ],
  "competitor_note": "one sentence naming which competitor gaps these pillars exploit, mentioning at least one competitor by name"
}
Exactly 3 pillars. Write for the stated ideal customer.`;

  const apiKey = ((process.env.Content_engine_Key_3 || process.env.ANTHROPIC_API_KEY || "").trim().replace(/^["']|["']$/g, ""));
  console.log("KEYINFO", apiKey.slice(0, 14), "len", apiKey.length);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("anthropic " + res.status + " " + body.slice(0, 300));
  }
  const data = await res.json();
  let text = (data.content?.[0]?.text || "").trim();
  text = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(text);
}

// Optional: push lead + preview into Close (only if CLOSE_API_KEY is set)
async function pushToClose(payload, result) {
  const key = process.env.CLOSE || process.env.CLOSE_API_KEY;
  if (!key) return;
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");
  try {
    const leadRes = await fetch("https://api.close.com/api/v1/lead/", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: payload.company || payload.email,
        url: normalizeUrl(payload.website) || undefined,
        contacts: [{ name: payload.email, emails: [{ email: payload.email, type: "office" }] }],
      }),
    });
    if (!leadRes.ok) return;
    const lead = await leadRes.json();
    const noteLines = [
      "CONTENT ENGINE LEAD (form submission)",
      `Company size: ${payload.size || "-"}`,
      `Website: ${payload.website || "-"}`,
      `Competitors: ${[payload.c1, payload.c2, payload.c3].filter(Boolean).join(", ") || "-"}`,
      `ICP: ${payload.icp || "-"}`,
      "",
      "GENERATED PREVIEW PILLARS:",
      ...(result?.pillars || []).map(
        (p, i) => `${i + 1}. ${p.name} [${p.wedge_type}] — ${p.why_it_converts} | Titles: ${(p.sample_titles || []).join(" / ")}`
      ),
      result?.competitor_note ? `Note: ${result.competitor_note}` : "",
    ];
    await fetch("https://api.close.com/api/v1/activity/note/", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: lead.id, note: noteLines.join("\n") }),
    });
  } catch {
    // CRM push is best-effort; never block the preview
  }
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors(origin) });

  let payload;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload || !payload.company) {
    return new Response(JSON.stringify({ error: "missing fields" }), { status: 400, headers: cors(origin) });
  }

  // Scrape prospect + competitors in parallel
  const comps = [payload.c1, payload.c2, payload.c3].filter(Boolean).slice(0, 3);
  const [siteText, ...compTextsRaw] = await Promise.all([
    fetchText(payload.website, 6000),
    ...comps.map((c) => fetchText(c, 4000)),
  ]);
  const compTexts = comps.map((name, i) => ({ name, text: compTextsRaw[i] || "" }));

  try {
    const result = await callClaude(payload, siteText, compTexts);
    // fire-and-forget CRM push (don't await fully; but await keeps function alive — cheap)
    await pushToClose(payload, result);
    return new Response(JSON.stringify(result), { status: 200, headers: cors(origin) });
  } catch (e) {
    console.log("GEN_ERR", String(e).slice(0, 500), "KEY_PRESENT", !!(process.env.ANTHROPIC_API_KEY || process.env.Content_engine_Key_3));
    return new Response(JSON.stringify({ error: "generation_failed", detail: String(e).slice(0, 300) }), { status: 502, headers: cors(origin) });
  }
}

export const config = { path: "/api/content-engine" };
