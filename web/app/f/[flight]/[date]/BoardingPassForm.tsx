'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

import { type BoardingPassLeg, parseBoardingPass } from '../../../../lib/bcbp.ts';
import VerificationBadge from '../../../../components/VerificationBadge.tsx';

/**
 * Tier 1: reading the seats off a boarding pass (CLAUDE.md §10).
 *
 * Everything here happens in the browser. The image is decoded here, the barcode
 * is parsed here, and what goes to the server is six fields per leg — never the
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
  verificationTier: number;
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
    .map((leg) => `${leg.carrier}${leg.flightNumber} seat ${leg.seat ?? '—'}`)
    .join(' · ');
}

export default function BoardingPassForm({ size, designator, verificationTier }: Props) {
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
            + 'than a photo of a screen — or paste the barcode text below.',
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
    <section className="rounded-lg border border-line p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-medium">Use your boarding pass</h2>
        <VerificationBadge tier={verificationTier} />
      </div>

      <p className="mt-2 text-sm text-muted">
        Scan the barcode instead of typing {size === 1 ? 'your seat' : 'your seats'} and
        we fill {size === 1 ? 'it' : 'them'} in for you. It also earns a badge other
        travellers can see — we check the pass against {designator}, against the
        aircraft, and against the seats already claimed.
      </p>
      <p className="mt-2 text-sm text-muted">
        The barcode is read on this page and never sent to us. We keep the seat and
        the check-in number; we do not read, send or store your name.
      </p>

      {canScan ? (
        <label className="mt-4 block">
          <span className="text-sm font-medium">
            {size === 1 ? 'Your boarding pass' : `All ${size} boarding passes`}
          </span>
          <input
            type="file"
            accept="image/*"
            multiple={size > 1}
            onChange={onFiles}
            disabled={scanning}
            // Outlined, not filled: typing the seat above is the page's primary
            // action and this is the optional upgrade to it.
            className="mt-1 block w-full text-sm text-muted file:mr-3 file:cursor-pointer file:rounded
                       file:border file:border-solid file:border-accent file:bg-white file:px-3
                       file:py-2 file:text-sm file:font-medium file:text-accent
                       hover:file:bg-accent/5"
          />
          <span className="mt-1 block text-xs text-muted">
            A screenshot of the pass reads more reliably than a photo of a screen.
            {scanning ? ' Reading…' : null}
          </span>
        </label>
      ) : null}

      {formats !== null && !canScan ? (
        <p className="mt-4 rounded border border-line bg-gray-50 p-3 text-sm text-muted">
          This browser cannot read barcodes on its own. You can paste the barcode
          text below, or just send your seat {size === 1 ? 'number' : 'numbers'} above —
          that works just as well, it simply does not carry a badge.
        </p>
      ) : null}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowPaste((open) => !open)}
          className="text-sm text-accent underline underline-offset-2"
        >
          {showPaste ? 'Hide' : 'Paste the barcode text instead'}
        </button>
        {showPaste ? (
          <div className="mt-2 space-y-2">
            <label htmlFor={pasteId} className="block text-sm font-medium">
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
              className="w-full rounded border border-field px-3 py-2 font-mono text-base
                         focus:border-accent sm:text-xs"
            />
            <p id={`${pasteId}-hint`} className="text-xs text-muted">
              Starts with <code>M1</code>. One pass per line.
            </p>
            <button
              type="button"
              onClick={onPaste}
              className="rounded border border-field px-3 py-1.5 text-sm font-medium hover:border-accent"
            >
              Read it
            </button>
          </div>
        ) : null}
      </div>

      {passes.length > 0 ? (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium">
            Read {passes.length} of {size}:
          </p>
          <ul className="space-y-1 text-sm">
            {passes.map((pass, index) => (
              <li key={`${pass.summary}-${index}`} className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">{pass.summary}</span>
                <button
                  type="button"
                  onClick={() => setPasses((current) => current.filter((_, i) => i !== index))}
                  className="text-xs text-muted underline underline-offset-2"
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
            className="w-full rounded bg-accent px-4 py-2 font-medium text-white
                       hover:bg-accent-dark disabled:opacity-50"
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
          className={`mt-3 text-sm ${status === 'error' ? 'text-red-600' : 'text-accent'}`}
        >
          {message}
        </p>
      ) : null}
    </section>
  );
}
