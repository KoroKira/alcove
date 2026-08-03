// Crumbs-style: a stable pastel tint per pad, mixed into the theme surface via
// color-mix (so it reads in both light and dark). Shared by the Dashboard and
// the Home Hub so colourful cards look consistent across the app.
const CARD_TINTS = [
  '245,194,231', '166,227,161', '243,139,168', '137,180,250',
  '249,226,175', '203,166,247', '148,226,213', '250,179,135',
];

export function cardTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CARD_TINTS[h % CARD_TINTS.length];
}
