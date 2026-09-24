# Editorial bulletin refresh

Branch: `codex/bulletin-editorial-refresh`. Existing editor work is preserved. No publishing or email-layout changes are part of this refresh.

## Design system

The selected design combines serif headlines, open unnumbered announcement rows, a warm mountain hero, and dark framing. Original CCAV logo files are used unchanged. Source Serif 4 and Inter are self-hosted, with licenses beside the fonts. Public styles are layered in `src/css/editorial.css` so existing editor styles remain independent.

At 1100 CSS pixels and wider, existing section nodes are grouped into two columns. Announcements and saved dates occupy the main column; service, schedule, and message occupy the secondary column. Both retain their configured relative order. Narrower layouts return the same nodes to their original configured order, preserving focus when resizing. Without JavaScript, the bulletin remains readable in one column.

Announcement images retain their full proportions and are capped in height rather than cropped. Broken images collapse without hiding the announcement or its links. Optional action groups wrap, with each QR next to its corresponding link.

## CTA compatibility

Each CTA accepts an optional boolean `showQr`. Missing values and newly created links default to true. Explicit false removes that QR while preserving its link. QR codes are hidden at 768 CSS pixels and narrower. The shared editor control round-trips this field through imports, drafts, reopening, and previewing; the email template is unchanged.

## Design artifacts

Imagegen's built-in tool produced the reference images and the separate mountain background. References were inspected before implementation; generated-logo distortions and flyer crops were corrected by using original assets and uncropped image sizing in the actual UI.

- Selected reference: `output/design/selected-bulletin.png`
- Archive, announcement, and QR-control reference: `output/design/supporting-surfaces.png`
- Production background: `src/assets/mountain-hero.png`
- Exact production-artwork prompt and supporting-reference prompt: `output/design/generation-prompts.md`

## Verification

Run `npm run build` and `npm test`. For browser review, run `npm run review`, then `node scripts/prepare-editorial-review.js`. Execute the resulting `output/playwright/browser-review.js` with Playwright CLI's `run-code --filename` option. Sample announcements are fulfilled only through a browser route; they are never written to the public website. The local `/__test/admin/` editor uses mocked publishing.

Visual checks cover 320px and 390px phones, 820px tablet, 1440px desktop, and a 720px CSS viewport equivalent to 200% zoom on a 1440px screen. Checks cover archives, current and past issues, full portrait/landscape images, broken images, long copy, and independent CTA/QR combinations. Rendered QR screenshots can be decoded to verify their destination. Generated review files are excluded from Git.
