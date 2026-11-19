// Post cards: one per platform, with the post time, a ready caption and the rules.
// You post by hand. Nothing connects to your accounts.

export const PLATFORMS = [
  { key: 'ig', name: 'Instagram', icon: '📸', time: 'meta' },
  { key: 'fbPage', name: 'Facebook Page', icon: '📘', time: 'meta' },
  { key: 'fbMe', name: 'Facebook personal', icon: '👤', time: 'fbMe' },
  { key: 'tt', name: 'TikTok', icon: '🎵', time: 'tt' },
  { key: 'yt', name: 'YouTube Shorts', icon: '▶️', time: 'yt' },
];

export const RULES = {
  ig: ['Links don\'t click here, so it ends with "Link in bio."', 'About 5 hashtags.'],
  fbPage: ['Links are clickable, so the full link is in the caption.'],
  fbMe: ['Links are clickable, so the full link is in the caption.', 'Post at 6:00 pm on reel days.'],
  tt: ['Shorter caption.', 'No sign-off line.'],
  yt: ['Title plus a short description.', 'No sign-off line.'],
};

export function defaultSettings() {
  return {
    times: { // Central time, per weekday (2 = Tue, 3 = Wed, 4 = Thu)
      2: { yt: '12:00', meta: '13:30', tt: '15:30' },
      3: { yt: '12:00', meta: '12:30', tt: '15:00' },
      4: { yt: '12:00', meta: '12:30', tt: '15:00' },
    },
    fbMe: '18:00',
    logo: { on: false, corner: 'tr', size: 0.16, opacity: 0.9 }, // logo on every reel
    mainLink: 'https://discoverhealthquest.com',
    testerOn: true,
    testerEnd: '2026-12-31',
    testerLine: "Texas parents, I'm looking for families to test HealthQuest. The first 50 get a free year.",
    testerLink: 'https://app.discoverhealthquest.com/auth/signup?code=HQTESTER&ref=hqtester',
    signoff: 'Be kind to others, and love yourself. Until next time!',
    closers: [
      "I'm April, just a girl trying to save healthcare up to $19 billion. Follow along.",
      "I'm April, a pediatric nurse practitioner, mom, and the creator of HealthQuest.",
    ],
    hashtags: '#PediatricNursePractitioner #FounderStory #HealthQuest #HealthDecoder',
    collab: '@healthquestapp',            // Instagram Collab partner
    igTag: '@eau103psu',                  // personal Instagram to tag
    fbTag: 'April Uy',                    // personal Facebook to tag
    fbTagLink: 'https://www.facebook.com/april.uy.37',
  };
}

export const fmtTime = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
};

export function timesFor(S, dateStr) {
  const day = dateStr ? new Date(dateStr + 'T12:00:00').getDay() : 4;
  const t = S.times[day] || S.times[4];
  return { yt: t.yt, meta: t.meta, tt: t.tt, fbMe: S.fbMe, usual: !!S.times[day] };
}

const testerActive = (S, dateStr) => S.testerOn && (!dateStr || dateStr <= S.testerEnd);
const tags = (S, n) => S.hashtags.split(/\s+/).filter((t) => t.startsWith('#')).slice(0, n).join(' ');
const firstSentences = (txt, n) => (txt.match(/[^.!?]+[.!?]+["')]*\s*/g) || [txt]).slice(0, n).join('').trim();

// Build each platform's caption from your caption (body), closer and settings.
export function buildCaptions(S, { body, closer, title, hook, date }) {
  const b = (body || '').trim();
  const tester = testerActive(S, date);
  const link = S.mainLink;
  const tl = S.testerLine;
  const lines = (...xs) => xs.filter(Boolean).join('\n\n');
  return {
    ig: lines(b, closer, tester ? `${tl} Link in bio.` : 'Link in bio to play HealthQuest.', S.signoff, tags(S, 5)),
    fbPage: lines(b, closer, tester ? `${tl} Sign up here: ${S.testerLink}` : `Go to ${link} and click Sign Up to play.`, S.signoff, tags(S, 3)),
    fbMe: lines(b, closer, tester ? `${tl} Sign up here: ${S.testerLink}` : `Go to ${link} and click Sign Up to play.`, S.signoff),
    tt: lines(firstSentences(b, 2), tester ? `${tl} Link in bio.` : 'Link in bio.', tags(S, 5)),
    yt: lines(firstSentences(b, 2), tester ? `${tl} Link on my channel page.` : `Play HealthQuest: ${link}`, tags(S, 3) + ' #Shorts'),
    ytTitle: (title || hook || '').replace(/\*/g, '').slice(0, 100),
  };
}

// Next Tue/Wed/Thu from today, as YYYY-MM-DD.
export function nextReelDay(from = new Date()) {
  const d = new Date(from);
  for (let i = 0; i < 8; i++) {
    if ([2, 3, 4].includes(d.getDay())) break;
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// Rules plus the collab/tag steps for each platform, from your settings.
export function rulesFor(key, S) {
  const r = [...RULES[key]];
  if (key === 'ig') {
    if (S.collab) r.push(`Before you share: Tag people → Invite collaborator → ${S.collab}.`);
    if (S.igTag) r.push(`Tag people → ${S.igTag}.`);
  }
  if (key === 'fbPage' && S.fbTag) r.push(`Tag ${S.fbTag} (type @${S.fbTag.split(' ')[0]} in the post), then share it to your personal profile.`);
  return r;
}
