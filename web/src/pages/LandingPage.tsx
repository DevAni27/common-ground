import { navigate } from '../api.ts';
import { Button, Shell } from '../ui.tsx';

/** Paths from four different homes that meet at one park — the product, drawn once on load. */
function TrailMap() {
  const paths = [
    { d: 'M30 60 C 90 70, 120 140, 190 170 S 250 200, 262 210', len: 300, delay: '0s' },
    { d: 'M470 50 C 420 90, 380 110, 340 150 S 290 195, 278 208', len: 260, delay: '.25s' },
    { d: 'M40 330 C 110 300, 160 290, 200 260 S 250 228, 262 220', len: 280, delay: '.5s' },
    { d: 'M480 320 C 430 300, 390 290, 350 262 S 300 232, 282 222', len: 250, delay: '.75s' },
  ];
  const homes = [[30, 60], [470, 50], [40, 330], [480, 320]];
  return (
    <svg viewBox="0 0 510 380" className="h-auto w-full" role="img" aria-label="Four dotted paths from different homes meeting at one park">
      {/* contour lines */}
      <g fill="none" stroke="var(--line)" strokeWidth="1.4">
        <path d="M-10 120 C 120 90, 260 140, 520 100" />
        <path d="M-10 250 C 140 230, 320 300, 520 260" />
        <ellipse cx="270" cy="215" rx="150" ry="95" />
        <ellipse cx="270" cy="215" rx="105" ry="64" />
      </g>
      {/* Dotted trails revealed by an animated mask, so the dots appear to be walked in. */}
      <defs>
        {paths.map((p, i) => (
          <mask key={i} id={`cg-trail-${i}`} maskUnits="userSpaceOnUse">
            <path d={p.d} fill="none" stroke="#fff" strokeWidth="10" strokeLinecap="round" className="cg-path" style={{ ['--len' as string]: p.len, animationDelay: p.delay }} />
          </mask>
        ))}
      </defs>
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill="none" stroke="var(--ink)" strokeWidth="3.2" strokeLinecap="round" strokeDasharray="0.5 10" mask={`url(#cg-trail-${i})`} />
      ))}
      {/* the park */}
      <ellipse cx="270" cy="215" rx="62" ry="38" fill="var(--leaf-soft)" stroke="var(--leaf)" strokeWidth="2" />
      <g fill="var(--leaf)">
        <circle cx="245" cy="205" r="9" /><circle cx="258" cy="198" r="11" /><circle cx="296" cy="228" r="9" /><circle cx="308" cy="219" r="7" />
      </g>
      {homes.map(([x, y], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <rect x="-11" y="-6" width="22" height="16" rx="3" fill="var(--card)" stroke="var(--ink)" strokeWidth="2" />
          <path d="M-14 -5 L0 -16 L14 -5" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
        </g>
      ))}
      {/* meeting pin */}
      <g className="cg-pop" style={{ animationDelay: '1.7s', transformOrigin: '270px 196px' }}>
        <path d="M270 196 c -14 -18, -14 -40, 0 -40 s 14 22, 0 40Z" fill="var(--marker)" stroke="var(--ink)" strokeWidth="2" />
        <circle cx="270" cy="170" r="5" fill="var(--ink)" />
      </g>
    </svg>
  );
}

const STEPS = [
  { title: 'Pick an area', text: 'Search any neighbourhood or town. Common Ground finds real parks, gardens and viewpoints nearby from OpenStreetMap. You keep the ones you like.' },
  { title: 'Share one link', text: 'Friends open it on their phones and add their limits: when they can leave, when they need to be home, budget, how far they can travel or walk.' },
  { title: 'See plans that fit everyone', text: 'Each place, time and length is checked against every person’s limits. If nothing fits, you see which shared change — earlier, shorter, somewhere else — would.' },
  { title: 'Everyone says yes', text: 'Everyone confirms the same plan. Print the outing card or save it on your phone, and go outside.' },
];

export function LandingPage() {
  return (
    <Shell wide bare>
      <section className="grid items-center gap-8 pt-6 pb-14 md:grid-cols-[1.05fr_1fr] md:pt-12">
        <div className="cg-enter">
          <h1 className="font-display text-5xl font-extrabold text-ink sm:text-6xl">Find a little common ground.</h1>
          <p className="mt-5 max-w-xl text-lg text-muted sm:text-xl">
            Everyone shares their limits privately. You get outdoor plans the whole group can actually say yes to — nobody has to explain why they can’t.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button className="px-7 text-lg" onClick={() => navigate('/new')}>Plan an outing</Button>
            <a href="#how" className="px-2 font-bold text-leaf underline decoration-2 underline-offset-4 hover:decoration-marker">How it works</a>
          </div>
          <p className="mt-4 text-sm text-muted">Free. No accounts. Works on any phone browser.</p>
        </div>
        <div className="rounded-[2rem] border border-line bg-card p-3 sm:p-5"><TrailMap /></div>
      </section>

      <section id="how" className="scroll-mt-6 border-t border-line py-14">
        <h2 className="font-display text-3xl font-bold">How it works</h2>
        <ol className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-marker font-display text-lg font-bold text-[#17261d]" aria-hidden="true">{i + 1}</span>
              <div>
                <h3 className="font-display text-xl font-bold">{s.title}</h3>
                <p className="mt-1 text-muted">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-10 border-t border-line py-14 md:grid-cols-2">
        <div>
          <h2 className="font-display text-3xl font-bold">Your limits stay yours</h2>
          <p className="mt-3 text-muted">The group sees places, times and whether an option works for everyone. It never sees who it doesn’t work for, or why.</p>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-3xl bg-leaf-soft p-5">
            <dt className="font-display text-lg font-bold">Only you see</dt>
            <dd className="mt-2 text-sm">Your budget, your time limits, your starting neighbourhood, your walking needs, and your own journey to each place.</dd>
          </div>
          <div className="rounded-3xl border border-line p-5">
            <dt className="font-display text-lg font-bold">Everyone sees</dt>
            <dd className="mt-2 text-sm">The places, meeting time, how many people are ready, and the final plan. Answers are deleted a week after the outing.</dd>
          </div>
        </dl>
      </section>

      <section className="border-t border-line py-14">
        <div className="max-w-3xl">
          <h2 className="font-display text-3xl font-bold">Where AI helps, and where it doesn’t</h2>
          <p className="mt-3 text-muted">
            Common Ground uses <strong className="text-ink">Gemma</strong>, a free open AI model from Google, running on the organiser’s own computer. It does two small jobs:
          </p>
          <ul className="mt-5 space-y-4">
            <li className="flex gap-3"><span className="mt-1 text-xl text-leaf" aria-hidden="true">✦</span><span><strong>Turns your words into the form.</strong> Type “back by 1 pm, about 300 total, I can’t walk far”, and Gemma fills in the settings for you to check. Nothing is saved until you press Save.</span></li>
            <li className="flex gap-3"><span className="mt-1 text-xl text-leaf" aria-hidden="true">✦</span><span><strong>Writes a one-line description of each plan</strong>, using only facts about the place. Any sentence with a made-up detail is thrown out and replaced with a plain one.</span></li>
          </ul>
          <p className="mt-5 text-muted">It never decides the plan. Matching is plain arithmetic on everyone’s answers, so the result is the same every time and doesn’t depend on the AI.</p>
        </div>
      </section>

      <section className="border-t border-line py-14 text-center">
        <h2 className="font-display text-3xl font-bold">Got a group that keeps saying “let’s go out sometime”?</h2>
        <Button className="mt-6 px-7 text-lg" onClick={() => navigate('/new')}>Plan an outing</Button>
      </section>
    </Shell>
  );
}
