#!/usr/bin/env node
/**
 * Syncs the built email HTML to Mailchimp as a draft campaign.
 * Never sends — someone must review and send manually from Mailchimp.
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
const EMAIL_HTML = path.join(__dirname, "../_site/email/index.html");
const BULLETIN_JSON = path.join(__dirname, "../src/_data/bulletin.json");

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

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const bulletin = JSON.parse(fs.readFileSync(BULLETIN_JSON, "utf-8"));
  const html = fs.readFileSync(EMAIL_HTML, "utf-8");

  const date = bulletin.date; // e.g. "2026-04-20"
  const campaignTitle = `CCAV Bulletin — ${date}`;
  const subjectLine = `Weekly Bulletin — ${bulletin.date}`;
  const fromName = "Calvary Chapel AV";
  const replyTo = bulletin.contact?.email || "ccav@calvarychapelav.org";

  // Look for any existing campaign with this exact title (any status)
  const search = await request("GET", "/campaigns?count=200");
  if (search.status !== 200) {
    console.error("Failed to list campaigns:", search.body);
    process.exit(1);
  }

  const existing = (search.body.campaigns || []).find(
    (c) => c.settings?.title === campaignTitle
  );

  let campaignId;

  if (existing) {
    campaignId = existing.id;
    console.log(`Updating existing draft: "${campaignTitle}" (${campaignId})`);

    const patch = await request("PATCH", `/campaigns/${campaignId}`, {
      settings: { subject_line: subjectLine, from_name: fromName, reply_to: replyTo },
    });
    if (patch.status !== 200) {
      console.error("Failed to patch campaign settings:", patch.body);
      process.exit(1);
    }
  } else {
    console.log(`Creating new draft: "${campaignTitle}"`);

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
      console.error("Failed to create campaign:", create.body);
      process.exit(1);
    }
    campaignId = create.body.id;
  }

  // Upload the HTML content
  const content = await request("PUT", `/campaigns/${campaignId}/content`, { html });
  if (content.status !== 200) {
    console.error("Failed to set campaign content:", content.body);
    process.exit(1);
  }

  console.log(`\n✓ Draft synced: "${campaignTitle}"`);
  console.log(`  Campaign ID : ${campaignId}`);
  console.log(`  Status      : draft (not sent — review in Mailchimp before sending)`);
  console.log(
    `  View at     : https://us1.admin.mailchimp.com/campaigns/edit?id=${campaignId}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
