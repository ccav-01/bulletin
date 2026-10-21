#!/usr/bin/env node
/**
 * Syncs built email HTML to Mailchimp as draft campaigns.
 * Never sends — someone must review and send manually from Mailchimp.
 *
 * Syncs every bulletin whose date hasn't passed yet (the current bulletin
 * plus any future-dated archives), so editing an early-archived bulletin
 * still updates its email draft. Campaigns that were already sent are
 * skipped — Mailchimp rejects edits to sent campaigns.
 *
 * Required env vars:
 *   MAILCHIMP_API_KEY  — your Mailchimp API key (ends in -us21, -us6, etc.)
 *   MAILCHIMP_LIST_ID  — the Audience ID to associate the campaign with
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.MAILCHIMP_API_KEY;
const LIST_ID = process.env.MAILCHIMP_LIST_ID;
const SITE_DIR = path.join(__dirname, "../_site");
const BULLETIN_JSON = path.join(__dirname, "../src/_data/bulletin.json");
const PREVIOUS_DIR = path.join(__dirname, "../src/_data/previous");

// Campaigns in these states can still be edited; 'sent'/'sending' cannot.
const EDITABLE_STATUSES = ["save", "paused", "schedule"];
// A hung request would hold the workflow's concurrency slot and block later syncs
const REQUEST_TIMEOUT_MS = 30000;

if (!API_KEY || !LIST_ID) {
  console.error("Missing MAILCHIMP_API_KEY or MAILCHIMP_LIST_ID env vars.");
  process.exit(1);
}

// Mailchimp server prefix lives at the end of the API key (e.g. "us21")
const DC = API_KEY.split("-").pop();

function request(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`anystring:${API_KEY}`).toString("base64");
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: `${DC}.api.mailchimp.com`,
      path: `/3.0${endpoint}`,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Mailchimp ${method} ${endpoint} timed out`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Today's date (YYYY-MM-DD) in the church's timezone
function todayPacific() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

// The current bulletin plus any archived bulletin whose email may not have
// been sent yet (date is today or later). Past archives' emails are history.
function bulletinsToSync() {
  const current = JSON.parse(fs.readFileSync(BULLETIN_JSON, "utf-8"));
  const today = todayPacific();
  const targets = [{ bulletin: current, html: path.join(SITE_DIR, "email/index.html") }];
  const unreadable = [];

  if (fs.existsSync(PREVIOUS_DIR)) {
    for (const f of fs.readdirSync(PREVIOUS_DIR)) {
      if (!f.endsWith(".json")) continue;
      let archived;
      try {
        archived = JSON.parse(fs.readFileSync(path.join(PREVIOUS_DIR, f), "utf-8"));
      } catch (err) {
        // One bad archive shouldn't stop the other drafts from syncing
        unreadable.push(`${f}: ${err.message}`);
        continue;
      }
      if (!archived.date || archived.date < today) continue;
      if (archived.date === current.date) continue;
      targets.push({
        bulletin: archived,
        html: path.join(SITE_DIR, `email/${archived.date}/index.html`),
      });
    }
  }
  return { targets, unreadable, today };
}

// Shown on the workflow run page, so "synced" vs "skipped" is visible without
// reading the raw log.
function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### Mailchimp sync", "", ...lines, ""].join("\n"));
}

async function syncBulletin(bulletin, htmlPath, allCampaigns) {
  const date = bulletin.date; // e.g. "2026-04-20"
  const campaignTitle = `CCAV Bulletin — ${date}`;
  const subjectLine = `Weekly Bulletin — ${date}`;
  const fromName = "Calvary Chapel AV";
  const replyTo = bulletin.contact?.email || "ccav@calvarychapelav.org";

  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Email HTML not built: ${htmlPath}`);
  }
  const html = fs.readFileSync(htmlPath, "utf-8");

  const matches = allCampaigns.filter((c) => c.settings?.title === campaignTitle);
  const editable = matches.find((c) => EDITABLE_STATUSES.includes(c.status));

  if (!editable && matches.length) {
    console.log(
      `• "${campaignTitle}" was already sent (status: ${matches[0].status}) — skipping.`
    );
    return `- ${date}: skipped — already ${matches[0].status} in Mailchimp, so edits can't reach that email`;
  }

  let campaign;
  if (editable) {
    console.log(`• Updating existing draft: "${campaignTitle}" (${editable.id})`);
    const patch = await request("PATCH", `/campaigns/${editable.id}`, {
      settings: {
        title: campaignTitle,
        subject_line: subjectLine,
        from_name: fromName,
        reply_to: replyTo,
      },
    });
    if (patch.status !== 200) {
      throw new Error(`Failed to patch campaign settings: ${JSON.stringify(patch.body)}`);
    }
    campaign = patch.body;
  } else {
    console.log(`• Creating new draft: "${campaignTitle}"`);
    const create = await request("POST", "/campaigns", {
      type: "regular",
      recipients: { list_id: LIST_ID },
      settings: {
        title: campaignTitle,
        subject_line: subjectLine,
        from_name: fromName,
        reply_to: replyTo,
      },
    });
    if (create.status !== 200) {
      throw new Error(`Failed to create campaign: ${JSON.stringify(create.body)}`);
    }
    campaign = create.body;
  }

  const content = await request("PUT", `/campaigns/${campaign.id}/content`, { html });
  if (content.status !== 200) {
    throw new Error(`Failed to set campaign content: ${JSON.stringify(content.body)}`);
  }

  console.log(`  ✓ Draft synced: "${campaignTitle}"`);
  console.log(`    Status  : draft (not sent — review in Mailchimp before sending)`);
  const viewUrl = `https://${DC}.admin.mailchimp.com/campaigns/edit?id=${campaign.web_id}`;
  console.log(`    View at : ${viewUrl}`);
  return `- ${date}: draft ${editable ? "updated" : "created"} — [open in Mailchimp](${viewUrl})`;
}

async function main() {
  const { targets, unreadable, today } = bulletinsToSync();
  console.log(
    `Syncing ${targets.length} bulletin(s): ${targets.map((t) => t.bulletin.date).join(", ")}`
  );
  const summary = [];

  // Fetch the campaign list once, newest first, so title matching sees recent drafts
  const search = await request(
    "GET",
    "/campaigns?count=200&sort_field=create_time&sort_dir=DESC"
  );
  if (search.status !== 200) {
    console.error("Failed to list campaigns:", search.body);
    process.exit(1);
  }
  const allCampaigns = search.body.campaigns || [];

  const failures = [];
  for (const t of targets) {
    try {
      summary.push(await syncBulletin(t.bulletin, t.html, allCampaigns));
    } catch (err) {
      console.error(`✗ ${t.bulletin.date}: ${err.message}`);
      summary.push(`- ${t.bulletin.date}: **failed** — ${err.message}`);
      failures.push(t.bulletin.date);
    }
  }
  for (const u of unreadable) {
    console.error(`✗ Could not read archive ${u}`);
    summary.push(`- **failed** to read archive ${u}`);
    failures.push(u.split(":")[0]);
  }
  summary.push("", `Archives dated before ${today} aren't synced; their emails have already gone out.`);
  writeSummary(summary);

  if (failures.length) {
    console.error(`\nSync failed for: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
