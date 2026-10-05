'use client';

import { useEffect, useRef, useState } from 'react';

import { EXAMPLE_PARTIES, EXAMPLE_ROWS } from '../lib/swap-example.ts';

/**
 * The home page's worked example: six rows of an A320 and one four-party swap
 * chain, switching between the seating now and after the swap. Fixed data, not a
 * live flight; lib/swap-example.ts has the parties and the test that keeps them
 * honest.
 *
 * The seat grid is a picture of the table under it, so it is hidden from screen
 * readers and the table carries the same information as buttons.
 */

const LEFT = ['A', 'B', 'C'];
const RIGHT = ['D', 'E', 'F'];
// Row number, three seats, the aisle, three seats.
const GRID = 'grid grid-cols-[24px_repeat(3,minmax(0,1fr))_20px_repeat(3,minmax(0,1fr))] gap-1.5';
const TABLE = 'grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-3.5';

const POOL_SIZE = EXAMPLE_PARTIES.reduce((n, party) => n + party.before.length, 0);

export default function SwapChainDemo({ autoPlay = true }: { autoPlay?: boolean }) {
  const [after, setAfter] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flip once on its own, so a visitor sees the rotation happen without having
  // to find the control. Not for anyone who has asked for less motion.
  useEffect(() => {
    if (!autoPlay) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    timer.current = setTimeout(() => setAfter(true), 1700);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [autoPlay]);

  // Any interaction cancels the flip, so it never fights the user.
  function stop() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  const occupant = new Map<string, (typeof EXAMPLE_PARTIES)[number]>();
  for (const party of EXAMPLE_PARTIES) {
    for (const seat of after ? party.after : party.before) occupant.set(seat, party);
  }

  function cell(row: number, column: string) {
    const code = `${row}${column}`;
    const party = occupant.get(code);
    const base =
      'flex h-[34px] items-center justify-center rounded-md font-mono text-[11px] font-semibold '
      + 'tracking-[0.04em] transition-[background-color,color] duration-500 ease-in-out '
      + 'motion-reduce:transition-none';
    if (!party) {
      return (
        <div key={code} title={`${code}, not in the pool`} className={`${base} bg-seat-empty`} />
      );
    }
    const dim = focus !== null && focus !== party.id;
    return (
      <div
        key={code}
        title={`${code}, ${party.name}`}
        className={base}
        style={{
          // Dimmed: the same hue at low alpha, so one party can be traced
          // through the chain while the others stay recognisable.
          background: dim ? `${party.color}22` : party.color,
          color: dim ? party.color : '#fff',
        }}
      >
        {party.initial}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-card border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line px-4 py-[11px]">
        <p className="label-mono font-normal">Cabin · {POOL_SIZE} seats in the pool</p>
        <div role="group" aria-label="Seating shown" className="flex gap-0.5 rounded-[7px] bg-track p-0.5">
          <Segment
            on={!after}
            onClick={() => {
              stop();
              setAfter(false);
              setFocus(null);
            }}
          >
            Now
          </Segment>
          <Segment
            on={after}
            onClick={() => {
              stop();
              setAfter(true);
            }}
          >
            After the swap
          </Segment>
        </div>
      </div>

      <div className="flex justify-center bg-well px-4 pb-2 pt-[18px]" aria-hidden="true">
        <div className="w-full max-w-[420px]">
          <div className={`${GRID} mb-[7px] font-mono text-[10px] text-body`}>
            <div />
            {LEFT.map((c) => <div key={c} className="text-center">{c}</div>)}
            <div />
            {RIGHT.map((c) => <div key={c} className="text-center">{c}</div>)}
          </div>
          <div className="flex flex-col gap-1.5">
            {EXAMPLE_ROWS.map((row) => (
              <div key={row} className={`${GRID} items-center`}>
                <div className="pr-0.5 text-right font-mono text-[10.5px] text-body">{row}</div>
                {LEFT.map((c) => cell(row, c))}
                <div />
                {RIGHT.map((c) => cell(row, c))}
              </div>
            ))}
          </div>
          <p className="pb-1.5 pt-[11px] text-center font-mono text-[10px] tracking-[0.05em] text-body">
            ↑ front of the aircraft
          </p>
        </div>
      </div>

      <div className={`${TABLE} gap-y-2.5 border-y border-line border-b-soft bg-well px-4 py-[9px]`}>
        <span className="label-mono font-normal">Party</span>
        <span className="label-mono font-normal">What they want</span>
        <span className="label-mono text-right font-normal">Seat change</span>
      </div>
      {EXAMPLE_PARTIES.map((party) => {
        const focused = focus === party.id;
        return (
          <button
            key={party.id}
            type="button"
            aria-pressed={focused}
            onClick={() => {
              stop();
              setFocus((current) => (current === party.id ? null : party.id));
              setAfter(true);
            }}
            className={
              `${TABLE} w-full items-center gap-y-1.5 border-b border-[#f2f4f4] px-4 py-3 text-left `
              + 'transition-colors hover:bg-[#f7f9f9] '
              + (focused ? 'bg-[#f2f6f6]' : 'bg-white')
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2 w-2 flex-none rounded-sm" style={{ background: party.color }} />
              <span className="text-sm font-semibold">{party.name}</span>
            </span>
            <span className="min-w-0 text-[13.5px] text-body">{party.wants}</span>
            <span className="flex items-center justify-end gap-2 whitespace-nowrap font-mono">
              <span className="text-xs text-body">{party.before.join(' + ')}</span>
              <span className="text-xs text-body">→</span>
              <span className="text-[13px] font-semibold text-ink">{party.after.join(' + ')}</span>
            </span>
          </button>
        );
      })}

      <div className="flex flex-col gap-1.5 px-4 py-[13px] text-[13px] leading-normal text-body">
        <p>
          Four people move, and only into seats these four parties already hold.
          Never an empty seat on the map, because the airline can sell one of those
          at any moment.
        </p>
        <p>
          No two or three of them could have sorted this out between themselves.
          Dana and Priya swapping on their own would leave Priya in a middle seat,
          and she would just say no.
        </p>
      </div>
    </div>
  );
}

function Segment({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={
        'rounded-[5px] px-[11px] py-[5px] text-xs font-medium transition-[background-color,color,box-shadow] '
        + (on ? 'bg-white text-ink shadow-seg' : 'bg-transparent text-body')
      }
    >
      {children}
    </button>
  );
}
