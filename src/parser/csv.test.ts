import { describe, expect, it } from 'vitest';
import { parseCsv, toIsoDate } from './csv';

const HEADER = 'Datum,Tijd,Valutadatum,Product,ISIN,Omschrijving,FX,Mutatie,,Saldo,,Order Id';

describe('parseCsv', () => {
  it('reads the 12 real columns, including currency and amount pairs', () => {
    const rows = parseCsv(
      `${HEADER}\n15-03-2025,10:32,15-03-2025,ETF,IE00B4L5Y983,"Koop 15 @ 76,50 EUR","1,0920",EUR,"-1147,50",EUR,"-115,09",abc`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '15-03-2025',
      time: '10:32',
      isin: 'IE00B4L5Y983',
      description: 'Koop 15 @ 76,50 EUR',
      fx: 1.092,
      mutatieCurrency: 'EUR',
      mutatieAmount: -1147.5,
      saldoAmount: -115.09,
      orderId: 'abc',
    });
  });

  it('parses European numbers with thousands separators', () => {
    const [row] = parseCsv(`${HEADER}\n02-01-2026,09:00,02-01-2026,,,iDEAL storting,,EUR,"1.234,56",EUR,"0,00",`);
    expect(row.mutatieAmount).toBe(1234.56);
  });

  it('keeps commas inside quoted fields', () => {
    const [row] = parseCsv(`${HEADER}\n02-01-2026,09:00,02-01-2026,"ACME, INC",US0000000000,Dividend,,USD,"1,00",USD,"1,00",`);
    expect(row.product).toBe('ACME, INC');
  });

  it('handles CRLF line endings and skips blank lines and short rows', () => {
    const rows = parseCsv(`${HEADER}\r\n\r\nshort,row\r\n02-01-2026,09:00,02-01-2026,,,Storting,,EUR,"1,00",EUR,"1,00",\r\n`);
    expect(rows).toHaveLength(1);
  });

  // Known bug: splitLine drops escaped quotes ("") — see issue "splitLine: handle escaped quotes"
  it.fails('keeps escaped quotes inside a quoted field', () => {
    const [row] = parseCsv(`${HEADER}\n02-01-2026,09:00,02-01-2026,"5"" ETF",US0000000000,Dividend,,USD,"1,00",USD,"1,00",`);
    expect(row.product).toBe('5" ETF');
  });
});

describe('toIsoDate', () => {
  it('uses +01:00 in winter and +02:00 in summer (Europe/Amsterdam)', () => {
    expect(toIsoDate('15-01-2025', '10:00')).toBe('2025-01-15T10:00:00+01:00');
    expect(toIsoDate('15-07-2025', '10:00')).toBe('2025-07-15T10:00:00+02:00');
  });

  it('switches on the last Sundays of March and October', () => {
    // 2025: DST starts 30 March, ends 26 October
    expect(toIsoDate('29-03-2025', '12:00')).toContain('+01:00');
    expect(toIsoDate('31-03-2025', '12:00')).toContain('+02:00');
    expect(toIsoDate('25-10-2025', '12:00')).toContain('+02:00');
    expect(toIsoDate('27-10-2025', '12:00')).toContain('+01:00');
  });
});
