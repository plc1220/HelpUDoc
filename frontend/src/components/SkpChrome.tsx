import type { FC } from 'react';

/**
 * The institutional chrome from the SKP design: a teal utility strip above the
 * app, and the ARIA lockup that identifies the product beneath it.
 *
 * These are the design's two identity elements, and they are separate on
 * purpose. The strip says whose system this is; the lockup says what the system
 * is called. Teal is the institutional voice here and never means "clickable" —
 * that is the accent blue's job everywhere else in the app.
 *
 * Colours are written out rather than taken from tokens because both elements
 * are fixed brand chrome: the strip stays teal with light type in dark mode
 * too, the way a masthead does.
 */

/** What the strip says on the left. Fixed — this is the issuing authority. */
const AUTHORITY = 'Suruhanjaya Kredit Pengguna';

const GlobeGlyph: FC = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#bff3ef"
    strokeWidth="1.8"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>
);

/**
 * The 34px teal bar that sits above everything.
 *
 * `context` is the right-hand slot — a division or role. It is optional and
 * renders nothing when absent, rather than showing a placeholder: an empty
 * government banner is better than one asserting something untrue.
 */
export const GovernmentStrip: FC<{ context?: string | null }> = ({ context }) => (
  <div
    className="flex h-[34px] shrink-0 items-center justify-between bg-teal-600 px-[22px]"
    role="note"
    aria-label={AUTHORITY}
  >
    <span className="flex items-center gap-[9px] text-[11.5px] font-semibold uppercase leading-none tracking-[0.1em] text-teal-50">
      <GlobeGlyph />
      {AUTHORITY}
    </span>
    {context ? (
      <span className="text-[11.5px] font-semibold leading-none text-teal-50">{context}</span>
    ) : null}
  </div>
);

/**
 * The SKP lockup: logo, then the product name stacked over its expansion.
 *
 * This is Option B from the header study. The expansion stays permanently
 * visible rather than being revealed on hover, and wraps to two short lines
 * inside a fixed 116px column. Pinning that column is the whole point of the
 * option: the expansion is the widest thing in the lockup, so bounding it stops
 * it pushing the workspace breadcrumb across the bar and recovers roughly 100px
 * for the workspace name, which is the primary object on the screen.
 *
 * The break is explicit and `whitespace-nowrap` stops the browser adding its
 * own. `font-brand` matters here: the workspace root sets Tailwind's `font-sans`,
 * which resolves to the platform stack, and in that font "Intelligence Assistant"
 * measures 117px against a 116px column and silently becomes a third line.
 *
 * There is no rule inside the lockup — the header draws one after it, which is
 * what separates the product identity from the breadcrumb.
 *
 * The logo image already reads "Suruhanjaya Kredit Pengguna", so it carries the
 * alt text and the text beside it is the product name alone. The expansion is
 * hidden below `md`, where 8px type is unreadable and the initialism carries the
 * identity on its own; the fixed column is scoped to the same breakpoint so it
 * does not leave a gap on a phone.
 */
export const AriaBrandLockup: FC = () => (
  <span className="flex shrink-0 items-center gap-[11px]">
    <img
      src="/skp-logo.png"
      alt="Suruhanjaya Kredit Pengguna — Consumer Credit Commission"
      className="block h-[30px] w-auto object-contain"
    />
    <span className="flex flex-col gap-[3px] font-brand md:w-[116px]">
      <span className="text-[15px] font-extrabold leading-none tracking-[-0.01em] text-slate-950 dark:text-slate-50">
        ARIA
      </span>
      <span className="hidden whitespace-nowrap text-[8px] font-semibold uppercase leading-[1.35] tracking-[0.04em] text-teal-600 dark:text-teal-400 md:block">
        Artificial Regulatory
        <br />
        Intelligence Assistant
      </span>
    </span>
  </span>
);
