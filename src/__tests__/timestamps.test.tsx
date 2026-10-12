/**
 * timestampToMs reads every timestamp shape the dashboard receives; TimestampCell
 * renders through it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { timestampToMs } from '../lib/timestamps.js';
import { TimestampCell } from '../components/TimestampCell.js';

afterEach(cleanup);

const ISO = '2026-10-12T08:00:00.000Z';
const MS = Date.parse(ISO);
const NS = BigInt(MS) * 1_000_000n;

describe('timestampToMs', () => {
  it.each([
    ['bigint nanoseconds', NS],
    ['numeric nanoseconds', Number(NS)],
    ['numeric milliseconds', MS],
    ['a nanosecond string', NS.toString()],
    ['an ISO string', ISO],
  ])('reads %s', (_label, ts) => {
    expect(timestampToMs(ts)).toBe(MS);
  });

  it.each([null, undefined, 'not a time'])('is NaN for %s', (ts) => {
    expect(timestampToMs(ts)).toBeNaN();
  });
});

describe('TimestampCell', () => {
  it('titles a nanosecond timestamp with its instant', () => {
    const { container } = render(<TimestampCell timestamp={NS} />);
    expect(container.querySelector('span')?.getAttribute('title')).toBeTruthy();
    expect(container.querySelector('span')?.getAttribute('title')).not.toBe(NS.toString());
  });

  it('shows an unparseable timestamp as given instead of throwing', () => {
    const { container } = render(<TimestampCell timestamp="not a time" />);
    expect(container.textContent).toBe('not a time');
    expect(container.querySelector('span')?.getAttribute('title')).toBe('not a time');
  });
});
