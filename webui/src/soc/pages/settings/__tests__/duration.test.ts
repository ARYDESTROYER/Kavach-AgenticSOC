/**
 * Plain duration readings for Settings help lines (Round 14, SPEC §4.9.5 and §4.9.6):
 * "1440 min" reads "24 hours", "21600 s" reads "6 hours", and a value already in its
 * own unit gets no reading that would only repeat it.
 */
import { describe, expect, it } from 'vitest';

import { durationReading, minutesReading, withReading } from '../duration';

describe('durationReading', () => {
  it('reads whole minutes, hours and days, days from two days up', () => {
    expect(durationReading(900)).toBe('15 minutes');
    expect(durationReading(60)).toBe('1 minute');
    expect(durationReading(21_600)).toBe('6 hours');
    expect(durationReading(86_400)).toBe('24 hours');
    expect(durationReading(259_200)).toBe('3 days');
    expect(durationReading(2_592_000)).toBe('30 days');
  });

  it('gives no reading for a value that is not whole, empty or not positive', () => {
    expect(durationReading(90)).toBe('');
    expect(durationReading(0)).toBe('');
    expect(durationReading(-60)).toBe('');
    expect(durationReading(null)).toBe('');
    expect(durationReading(Number.NaN)).toBe('');
  });

  it('keeps the reading to units larger than the field', () => {
    // A field in minutes: 15 minutes would only repeat "15 min".
    expect(durationReading(900, 60)).toBe('');
    expect(durationReading(43_200, 60)).toBe('12 hours');
    // A field in hours: 6 hours would repeat "6 h"; 30 days reads.
    expect(durationReading(21_600, 3_600)).toBe('');
    expect(durationReading(2_592_000, 3_600)).toBe('30 days');
  });
});

describe('minutesReading and withReading', () => {
  it('says minute counts as people do', () => {
    expect(minutesReading(15)).toBe('15 minutes');
    expect(minutesReading(1)).toBe('1 minute');
    expect(minutesReading(240)).toBe('4 hours');
    expect(minutesReading(1_440)).toBe('24 hours');
    expect(minutesReading(4_320)).toBe('3 days');
    expect(minutesReading(90)).toBe('90 minutes');
  });

  it('puts the reading in brackets before the full stop, only when there is one', () => {
    expect(withReading('How often the summary is rebuilt.', '24 hours')).toBe('How often the summary is rebuilt (24 hours).');
    expect(withReading('How often the summary is rebuilt.', '')).toBe('How often the summary is rebuilt.');
  });
});
