'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

import { type BoardingPassLeg, parseBoardingPass } from '../../../../lib/bcbp.ts';
import { Card, CardFooter, CardHeader } from '../../../../components/Chrome.tsx';

/**
 * Tier 1: reading the seats off a boarding pass (CLAUDE.md §10).
 *
 * Everything here happens in the browser. The image is decoded here, the barcode
 * is parsed here, and what goes to the server is six fields per leg: never the
 * passenger name, never the raw payload (CLAUDE.md §13.1). That is not a detail
 * of the implementation, it is the reason we can ask for a boarding pass at all.
 *
 * The decoder is the browser's own BarcodeDetector, which reads PDF417 (paper) and
 * Aztec (mobile) with no library at all: the boring solution, and one dependency
 * fewer to ship to every visitor (CLAUDE.md §17). It is missing on Safari and
 * Firefox, so the paste box below is not a nicety — for those users it is the
 * whole feature, and for everyone it is the escape hatch when a photo will not
 * decode. Either way this screen is optional: typing your seat is tier 0, tier 0
 * is the default, and no tier is required to take part.
 */

interface Props {
  size: number;
  designator: string;
}

/** BarcodeDetector is not in lib.dom yet; this is the slice of it we use. */
interface Detector {
  detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>;
}
interface DetectorConstructor {
  new (options?: { formats?: string[] }): Detector;
  getSupportedFormats?(): Promise<string[]>;
}

/** Paper boarding passes are PDF417; phone ones are Aztec. */
const WANTED_FORMATS = ['pdf417', 'aztec', 'qr_code', 'data_matrix'];

interface ReadPass {
  legs: BoardingPassLeg[];
  /** What we show back, so somebody can see we read the right pass. */
  summary: string;
}

function summarise(legs: BoardingPassLeg[]): string {
  return legs
    .map((leg) => `${leg.carrier}${leg.flightNumber} seat ${leg.seat ?? 'none'}`)
    .join(' · ');
}

export default function BoardingPassForm({ size, designator }: Props) {
  const router = useRouter();
  const pasteId = useId();
  const [formats, setFormats] = useState<string[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [passes, setPasses] = useState<ReadPass[]>([]);
  const [pasted, setPasted] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const Ctor = (globalThis as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
    if (!Ctor?.getSupportedFormats) {
      setFormats([]);
      return;
    }
    // Support is per-platform even where the API exists, so ask rather than assume.
    Ctor.getSupportedFormats()
      .then((available) => setFormats(WANTED_FORMATS.filter((f) => available.includes(f))))
      .catch(() => setFormats([]));
  }, []);

  function addPass(raw: string, source: string): boolean {
    const parsed = parseBoardingPass(raw);
    if (!parsed.ok) {
      setMessage(`${source}: ${parsed.error}`);
      setStatus('error');
      return false;
    }
    setPasses((current) => [...current, { legs: parsed.pass.legs, summary: summarise(parsed.pass.legs) }]);
    return true;
  }

  async function onFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = ''; // so the same file can be picked again after a failure
    if (files.length === 0 || !formats || formats.length === 0) return;

    setScanning(true);
    setStatus('idle');
    setMessage('');

    const Ctor = (globalThis as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector!;
    const detector = new Ctor({ formats });

    for (const file of files) {
      try {
        const bitmap = await createImageBitmap(file);
        const found = await detector.detect(bitmap);
        bitmap.close?.();
        if (found.length === 0) {
          setStatus('error');
          setMessage(
            `No barcode in ${file.name}. A screenshot of the pass usually works better `
            + 'than a photo of a screen, or you can paste the barcode text below.',
          );
          continue;
        }
        addPass(found[0].rawValue, file.name);
      } catch {
        setStatus('error');
        setMessage(`We could not open ${file.name}.`);
      }
    }
    setScanning(false);
  }

  function onPaste() {
    const lines = pasted.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return;
    setStatus('idle');
    setMessage('');
    let added = 0;
    for (const line of lines) if (addPass(line, 'That text')) added += 1;
    if (added > 0) setPasted('');
  }

  async function submit() {
    setStatus('saving');
    let response: Response;
    try {
      response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only the parsed legs. The barcode itself stays in this tab.
        body: JSON.stringify({ passes: passes.map((pass) => pass.legs) }),
      });
    } catch {
      setStatus('error');
      setMessage('We could not reach the server. Check your connection and try again.');
      return;
    }
    const body = await response.json().catch(() => ({ error: 'Something went wrong' }));

    setStatus(response.ok ? 'saved' : 'error');
    setMessage(body.message ?? body.error ?? 'Something went wrong');
    if (response.ok) {
      setPasses([]);
      // The seats above and both badges are server-rendered.
      router.refresh();
    }
  }

  const canScan = formats !== null && formats.length > 0;

  return (
    <Card>
      <CardHeader title="Use your boarding pass" meta="Optional" />
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm text-body">
          Scan the barcode and we fill {size === 1 ? 'your seat' : 'your seats'} in for
          you. It also earns a badge other travellers can see, because we check the
          pass against {designator}, against the aircraft, and against the seats
          already claimed.
        </p>

        {canScan ? (
          <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-dashed border-slot bg-well p-[13px]">
            {/* The real input is hidden behind a button-shaped label, so the
                browser's "No file chosen" text does not sit in the design. */}
            <label
              className={
                'cursor-pointer rounded-[7px] border border-accent bg-white px-[13px] py-2 text-[13px] '
                + 'font-semibold text-accent hover:bg-accent/[.06] focus-within:outline '
                + 'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent'
              }
            >
              <input
                type="file"
                accept="image/*"
                multiple={size > 1}
                onChange={onFiles}
                disabled={scanning}
                className="sr-only"
              />
              {scanning
                ? 'Reading…'
                : size === 1 ? 'Choose your boarding pass' : `Choose ${size} boarding passes`}
            </label>
            <span className="text-[12.5px] text-body">
              A screenshot reads better than a photo of a screen.
            </span>
          </div>
        ) : null}

        {formats !== null && !canScan ? (
          <p className="rounded-lg border border-dashed border-slot bg-well p-[13px] text-[13px] text-body">
            This browser cannot read barcodes on its own. You can paste the barcode
            text below, or just send your seat {size === 1 ? 'number' : 'numbers'}. That
            works just as well, it simply does not carry a badge.
          </p>
        ) : null}

        <div>
          <button
            type="button"
            onClick={() => setShowPaste((open) => !open)}
            aria-expanded={showPaste}
            className="link text-[13.5px]"
          >
            {showPaste ? 'Hide the barcode text box' : 'Paste the barcode text instead'}
          </button>
          {showPaste ? (
            <div className="mt-2 flex flex-col gap-1.5">
              <label htmlFor={pasteId} className="label-mono">
                Barcode text
              </label>
              <textarea
                id={pasteId}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                rows={3}
                placeholder="M1ROSSI/ANNA          EABC123 OTPBGYFR 1234 285Y014A0025 100"
                aria-describedby={`${pasteId}-hint`}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                // 16px on phones: iOS Safari zooms into any field smaller than
                // that, and iOS is exactly where this box gets used, because
                // Safari has no BarcodeDetector.
                className="input-text font-mono sm:text-xs"
              />
              <p id={`${pasteId}-hint`} className="text-[12.5px] text-body">
                Starts with <code className="font-mono">M1</code>. One pass per line.
              </p>
              <button type="button" onClick={onPaste} className="btn-secondary self-start px-3 py-1.5 text-[13px]">
                Read it
              </button>
            </div>
          ) : null}
        </div>

        {passes.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="label-mono">
              Read {passes.length} of {size}
            </p>
            <ul className="divide-y divide-soft rounded-lg border border-line">
              {passes.map((pass, index) => (
                <li key={`${pass.summary}-${index}`} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="font-mono text-xs">{pass.summary}</span>
                  <button
                    type="button"
                    onClick={() => setPasses((current) => current.filter((_, i) => i !== index))}
                    className="text-xs text-body underline underline-offset-2 hover:text-ink"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={submit}
              disabled={status === 'saving' || passes.length !== size}
              className="btn-primary w-full"
            >
              {status === 'saving'
                ? 'Checking…'
                : passes.length === size
                  ? 'Use these seats'
                  : `Add ${size - passes.length} more`}
            </button>
          </div>
        ) : null}

        {message ? (
          <p
            role={status === 'error' ? 'alert' : 'status'}
            className={`text-[13px] ${status === 'error' ? 'text-danger' : 'text-accent'}`}
          >
            {message}
          </p>
        ) : null}
      </div>
      <CardFooter>
        The barcode is read on this page and stays in this tab. We keep the seat and
        the check-in number, and nothing else off it.
      </CardFooter>
    </Card>
  );
}
