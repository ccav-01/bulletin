# Admin redesign review

## Run locally

Run `npm ci`, `npm run build`, and `npm test`. Start `npm run review`, then open
http://127.0.0.1:4173/__test/admin/ for the editor with local sample authentication
and in-memory GitHub responses. This special route exists only in the review
server; it is not generated or deployed. Its Publish and Archive buttons exercise
mock writes. The regular `/admin/` route still uses real authentication.

The review server binds to the loopback interface. Its fixtures load the current
bulletin and the most recent archive. Browser draft recovery is enabled. No source
bulletin files are changed by review actions.

## Editor and preview

At 1200px and above the sidebar, editor, and full preview appear together. Smaller
viewports use a navigation drawer and Edit/Preview controls. Phone and Desktop
preview modes render at 390px and 1440px, respectively, and scale to fit. Expand
preview for closer inspection; Escape closes it. Cards and section order support
dragging and keyboard-accessible Move up/down actions.

`scripts/build-preview.js` precompiles the public Nunjucks templates and bundles
the same formatting helpers used by Eleventy. The browser preview renders current
form data into an isolated iframe. Template changes therefore require a rebuild.
Images, section settings, archive context, appearance settings, and QR output use
the shared templates. Scripts are removed and external link navigation is disabled
inside the preview. A rendering error leaves the prior view visible and does not
block draft saving. The preview is always labeled Unpublished draft.

Authentication, browser draft storage keys, upload handling, GitHub SHA conflict
checks, archive operations, and deployment tracking are retained. Ordinary publish
and Archive & Start New Week remain separate actions. Deployment status reports
the website and email sync outcomes separately.

Archive & Start New Week appears in a persistent action bar above every current
bulletin editor, including on mobile. Publishing a bulletin dated before today's
date in America/Los_Angeles opens a modal with Archive & Start New Week, Publish
this date, and Keep editing. It displays the archive workflow's actual next date
and explains that starting the new week updates the live bulletin. Escape cancels,
and Keep editing receives initial focus. The existing archive confirmation and
conflict checks still apply. Today, future dates, and archive edits skip this warning.

## Headline data

The optional schema is `headline: { title: string, reference: string }`.
With both fields populated, the reference appears below the title. Reference-only
weeks use the reference as the main heading. Title-only weeks omit the reference;
empty fields show Weekly Bulletin. Scripture & Sermon remains an independent
content section.

Legacy data without `headline` is interpreted at render time. Only a recognized
trailing Bible reference is separated; ambiguous text remains intact. Saving
includes a compatible combined `theme` value. Historical JSON files are not
rewritten. Imports can update either headline field independently; older imports
keep their existing behavior. Email headers and archive summaries use these same
normalization helpers. Numeric chapter/verse ranges are kept together when text
wraps.

## Verification

Regression tests cover headline compatibility and states, server/browser
preview parity, escaping and QR output, browser draft recovery, partial imports,
keyboard reorder controls, section visibility, archive switching, conflict
protection, failed publishing, stale previews, starting a new week, and separate
website/email deployment outcomes. Date-warning checks cover all choices,
duplicate publish attempts, archive edits, and the church's midnight boundary.
All writes in these tests are mocked.

The build includes URL validation. Admin and headline layouts were inspected at
390, 768, 1024, 1440, and 1920px; the expanded preview, visible focus, navigation
drawer, reference-only header, and mobile link fields were also inspected.
Native browser zoom could not be exercised through the in-app browser; an actual
200% browser zoom check remains a manual review item.

The public-site editorial refresh is integrated in the same checkout. Its assets,
templates, and responsive behavior are shared with the preview, including the
desktop reading columns. The integrated desktop preview was visually inspected
before deployment. Current September content and the GitHub Pages/Mailchimp
deployment workflows are preserved.
