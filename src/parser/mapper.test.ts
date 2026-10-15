import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { mapToActivities } from './mapper';

const HEADER = 'Datum,Tijd,Valutadatum,Product,ISIN,Omschrijving,FX,Mutatie,,Saldo,,Order Id';
const ETF = 'ISHARES CORE MSCI WORLD UCITS ETF,IE00B4L5Y983';

/** Build a CSV row. `amt` is already in DeGiro's format, e.g. "-1147,50". */
function row(opts: { date?: string; time?: string; product?: string; desc: string; fx?: string; ccy?: string; amt: string; order?: string }) {
  const [product, isin] = (opts.product ?? ',').split(',');
  return `${opts.date ?? '15-03-2025'},${opts.time ?? '10:32'},${opts.date ?? '15-03-2025'},${product},${isin},"${opts.desc}",${opts.fx ? `"${opts.fx}"` : ''},${opts.ccy ?? 'EUR'},"${opts.amt}",${opts.ccy ?? 'EUR'},"0,00",${opts.order ?? ''}`;
}

const run = (...rows: string[]) => mapToActivities(parseCsv([HEADER, ...rows].join('\n')));

describe('trades', () => {
  it('maps a buy and merges the transaction fee into it', () => {
    const acts = run(
      row({ product: ETF, desc: 'DEGIRO Transactiekosten en/of kosten van derden', amt: '-2,00', order: 'o1' }),
      row({ product: ETF, desc: 'Koop 15 @ 76,50 EUR', amt: '-1147,50', order: 'o1' }),
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({
      activityType: 'BUY', symbol: 'IE00B4L5Y983', quantity: 15, unitPrice: 76.5, fee: 2, amount: 1147.5, currency: 'EUR',
    });
  });

  it('parses quantity and price with thousands separators', () => {
    const acts = run(
      row({ product: ETF, desc: 'Koop 1.000 @ 1.234,56 EUR', amt: '-1.234.560,00', order: 'o1' }),
      row({ product: ETF, desc: 'Verkoop 2.500 @ 12,5 EUR', amt: '31.250,00', order: 'o2' }),
    );
    expect(acts.map(a => [a.activityType, a.quantity, a.unitPrice, a.amount])).toEqual([
      ['BUY', 1000, 1234.56, 1234560],
      ['SELL', 2500, 12.5, 31250],
    ]);
  });

  it('aggregates partial fills with the same Order Id into one weighted-average trade', () => {
    const acts = run(
      row({ product: ETF, desc: 'Koop 10 @ 100 EUR', amt: '-1000,00', order: 'o1' }),
      row({ product: ETF, desc: 'Koop 10 @ 110 EUR', amt: '-1100,00', order: 'o1' }),
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ quantity: 20, unitPrice: 105, amount: 2100 });
  });

  it('keeps French FTT as a separate TAX but skips its same-day reversal', () => {
    const acts = run(
      row({ product: ETF, desc: 'Koop 1 @ 100 EUR', amt: '-100,00', order: 'o1' }),
      row({ product: ETF, desc: 'Transactiebelasting', amt: '-0,30', order: 'o1' }),
      row({ product: ETF, desc: 'Transactiebelasting', amt: '0,30', order: 'o1' }),
    );
    expect(acts.map(a => a.activityType).sort()).toEqual(['BUY', 'TAX']);
  });
});

describe('dividends', () => {
  it('merges Dividendbelasting into the dividend: amount = gross - tax', () => {
    const acts = run(
      row({ date: '30-09-2025', product: ETF, desc: 'Dividend', ccy: 'USD', amt: '20,33' }),
      row({ date: '30-09-2025', product: ETF, desc: 'Dividendbelasting', ccy: 'USD', amt: '-3,05' }),
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ activityType: 'DIVIDEND', amount: 17.28, tax: 3.05, currency: 'USD' });
  });

  it('keeps an unmatched Dividendbelasting as a standalone TAX', () => {
    const acts = run(row({ date: '30-09-2025', product: ETF, desc: 'Dividendbelasting', ccy: 'USD', amt: '-3,05' }));
    expect(acts.map(a => a.activityType)).toEqual(['TAX']);
  });

  it('does not merge tax across different currencies', () => {
    const acts = run(
      row({ date: '30-09-2025', product: ETF, desc: 'Dividend', ccy: 'USD', amt: '20,33' }),
      row({ date: '30-09-2025', product: ETF, desc: 'Dividendbelasting', ccy: 'EUR', amt: '-3,05' }),
    );
    expect(acts.map(a => a.activityType).sort()).toEqual(['DIVIDEND', 'TAX']);
    expect(acts.find(a => a.activityType === 'DIVIDEND')).toMatchObject({ amount: 20.33 });
  });

  // Known bug (#5): a negative dividend (correction) imports as a positive dividend.
  it.fails('does not import a negative dividend as a positive one', () => {
    const acts = run(row({ date: '30-09-2025', product: ETF, desc: 'Dividend', ccy: 'USD', amt: '-20,33' }));
    expect(acts).toHaveLength(0);
  });
});

describe('cash rows', () => {
  it('maps deposits, withdrawals and fees', () => {
    const acts = run(
      row({ desc: 'flatex Storting', amt: '500,00' }),
      row({ desc: 'iDEAL storting', amt: '1000,00' }),
      row({ desc: 'Processed Flatex Withdrawal', amt: '-500,00' }),
      row({ desc: 'DEGIRO Aansluitingskosten 2025 (Xetra - XET)', amt: '-2,50' }),
    );
    expect(acts.map(a => a.activityType).sort()).toEqual(['DEPOSIT', 'DEPOSIT', 'FEE', 'WITHDRAWAL']);
  });

  it('skips the positive reversal of a withdrawal', () => {
    expect(run(row({ desc: 'Processed Flatex Withdrawal', amt: '500,00' }))).toHaveLength(0);
  });

  it('imports negative interest with a warning and skips zero interest', () => {
    const acts = run(
      row({ desc: 'Flatex Interest', amt: '-0,89' }),
      row({ desc: 'Flatex Interest Income', amt: '0,00' }),
    );
    expect(acts).toHaveLength(1);
    expect(acts[0].activityType).toBe('INTEREST');
    expect(acts[0].warnings).toHaveProperty('amount');
  });

  it('skips internal noise (cash sweeps, money market fund, flatex account)', () => {
    const acts = run(
      row({ desc: 'Cash Sweep Transfer', amt: '100,00' }),
      row({ desc: 'Overboeking', amt: '100,00' }),
      row({ product: 'MS FUND,LU1959429272', desc: 'Koop 1 @ 100 EUR', amt: '-100,00', order: 'o1' }),
      row({ product: 'FLATEX,NLFLATEXACNT', desc: 'Storting', amt: '100,00' }),
    );
    expect(acts).toHaveLength(0);
  });
});

// ─── Shapes seen in a real export (synthetic numbers) ────────────────────────
// Tags like (#13) refer to issues in the project tracker. `it.fails` documents a
// known gap: it passes while the bug exists and turns red once it is fixed —
// switch it to `it` then. `it.todo` marks behaviour that still needs a design.

describe('USD trades with currency conversion rows', () => {
  const usd = 'ALPHA SEMICONDUCTOR CORP.,US0135221041';

  // Valuta rows share the trade's Order Id; the FX column sits on the USD side only.
  const buyGroup = (order: string, qty: number, priceUsd: string, usdAmt: string, eurAmt: string, fx: string) => [
    row({ product: usd, desc: `Koop ${qty} @ ${priceUsd} USD`, ccy: 'USD', amt: `-${usdAmt}`, order }),
    row({ product: usd, desc: 'Valuta Creditering', ccy: 'USD', amt: usdAmt, fx, order }),
    row({ product: usd, desc: 'Valuta Debitering', ccy: 'EUR', amt: `-${eurAmt}`, order }),
  ];

  it('converts the EUR fee into the trade currency using the FX rate', () => {
    const acts = run(
      ...buyGroup('o1', 3, '173,43', '520,30', '432,10', '1,2100'),
      row({ product: usd, desc: 'DEGIRO Transactiekosten en/of kosten van derden', amt: '-0,02', order: 'o1' }),
      row({ product: usd, desc: 'DEGIRO Transactiekosten en/of kosten van derden', amt: '-0,45', order: 'o1' }),
    );
    expect(acts).toHaveLength(1);
    // two fee rows (0.47 EUR) × 1.21 USD/EUR
    expect(acts[0]).toMatchObject({ activityType: 'BUY', currency: 'USD', quantity: 3, fee: 0.57 });
  });

  it('does not turn the conversion rows into activities of their own (yet)', () => {
    expect(run(...buyGroup('o1', 3, '173,43', '520,30', '432,10', '1,2100'))).toHaveLength(1);
  });

  it('aggregates partial fills that each carry their own conversion pair', () => {
    const acts = run(
      ...buyGroup('o1', 10, '100', '1000,00', '800,00', '1,2500'),
      ...buyGroup('o1', 10, '110', '1100,00', '880,00', '1,2500'),
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ quantity: 20, unitPrice: 105, amount: 2100 });
  });

  it('handles a USD sale where the FX rate is on the Debitering row', () => {
    const acts = run(
      row({ product: usd, desc: 'Verkoop 5 @ 28,150 USD', ccy: 'USD', amt: '140,75', order: 'o1' }),
      row({ product: usd, desc: 'Valuta Debitering', ccy: 'USD', amt: '-140,75', fx: '1,1250', order: 'o1' }),
      row({ product: usd, desc: 'Valuta Creditering', ccy: 'EUR', amt: '125,11', order: 'o1' }),
      row({ product: usd, desc: 'DEGIRO Transactiekosten en/of kosten van derden', amt: '-2,00', order: 'o1' }),
    );
    expect(acts[0]).toMatchObject({ activityType: 'SELL', quantity: 5, unitPrice: 28.15, currency: 'USD', fee: 2.25 });
  });

  // (#11) fxRate is never set on an activity; DeGiro quotes USD per EUR.
  it.fails('sets fxRate from the conversion pair on the trade', () => {
    const [act] = run(...buyGroup('o1', 3, '173,43', '520,30', '432,10', '1,2100'));
    expect(act.fxRate).toBeCloseTo(432.1 / 520.3, 3);
  });

  // (#11) with partial fills the rate is total EUR / total USD, not the first fill's rate.
  it.fails('uses the weighted rate when partial fills have different rates', () => {
    const [act] = run(
      ...buyGroup('o1', 10, '100', '1000,00', '800,00', '1,2500'),
      ...buyGroup('o1', 10, '110', '1100,00', '1000,00', '1,1000'),
    );
    expect(act.fxRate).toBeCloseTo(1800 / 2100, 4);
  });

  // (#12) Wealthfolio's amount is the final cash, fee included.
  it.fails('BUY amount includes the fee', () => {
    const [act] = run(
      row({ product: ETF, desc: 'DEGIRO Transactiekosten en/of kosten van derden', amt: '-2,00', order: 'o1' }),
      row({ product: ETF, desc: 'Koop 15 @ 76,50 EUR', amt: '-1147,50', order: 'o1' }),
    );
    expect(act.amount).toBe(1149.5);
  });

  it.fails('SELL amount is net of the fee', () => {
    const [act] = run(
      row({ product: ETF, desc: 'DEGIRO Transactiekosten en/of kosten van derden', amt: '-2,00', order: 'o1' }),
      row({ product: ETF, desc: 'Verkoop 7 @ 112,40 EUR', amt: '786,80', order: 'o1' }),
    );
    expect(act.amount).toBe(784.8);
  });
});

describe('EUR trades', () => {
  it('sums several fee rows and many partial fills of one order', () => {
    const fills = Array.from({ length: 13 }, () => row({ product: ETF, desc: 'Verkoop 1 @ 100 EUR', amt: '100,00', order: 'o1' }));
    const acts = run(
      row({ product: ETF, desc: 'DEGIRO Transactiekosten en/of kosten van derden', amt: '-1,00', order: 'o1' }),
      ...fills,
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ activityType: 'SELL', quantity: 13, unitPrice: 100, amount: 1300, fee: 1 });
  });

  it('imports a trade without a fee row', () => {
    const acts = run(row({ product: ETF, desc: 'Koop 2 @ 50 EUR', amt: '-100,00', order: 'o1' }));
    expect(acts[0]).toMatchObject({ activityType: 'BUY', fee: 0, amount: 100 });
  });
});

describe('dividends: more shapes', () => {
  it('sums several Dividendbelasting rows into the dividend', () => {
    const acts = run(
      row({ date: '28-10-2025', product: ETF, desc: 'Dividend', ccy: 'USD', amt: '10,00' }),
      row({ date: '28-10-2025', product: ETF, desc: 'Dividendbelasting', ccy: 'USD', amt: '-1,00' }),
      row({ date: '28-10-2025', product: ETF, desc: 'Dividendbelasting', ccy: 'USD', amt: '-2,00' }),
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ activityType: 'DIVIDEND', tax: 3, amount: 7 });
  });

  it('merges EUR dividends with EUR withholding', () => {
    const acts = run(
      row({ date: '28-10-2025', product: ETF, desc: 'Dividend', amt: '10,00' }),
      row({ date: '28-10-2025', product: ETF, desc: 'Dividendbelasting', amt: '-1,50' }),
    );
    expect(acts[0]).toMatchObject({ activityType: 'DIVIDEND', tax: 1.5, amount: 8.5, currency: 'EUR' });
  });

  it('imports a dividend without withholding tax unchanged', () => {
    const [act] = run(row({ date: '28-10-2025', product: ETF, desc: 'Dividend', ccy: 'USD', amt: '4,20' }));
    expect(act).toMatchObject({ activityType: 'DIVIDEND', amount: 4.2 });
    expect(act.tax ?? 0).toBe(0);
  });

  // (#21) custody fee a couple of minutes after the dividend, same ISIN/date/currency
  it.fails('merges ADR/GDR Externe Kosten into the dividend fee', () => {
    const [act] = run(
      row({ date: '28-10-2025', time: '09:15', product: ETF, desc: 'Dividend', ccy: 'USD', amt: '7,80' }),
      row({ date: '28-10-2025', time: '09:15', product: ETF, desc: 'Dividendbelasting', ccy: 'USD', amt: '-2,15' }),
      row({ date: '28-10-2025', time: '09:17', product: ETF, desc: 'ADR/GDR Externe Kosten', ccy: 'USD', amt: '-0,22' }),
    );
    expect(act).toMatchObject({ activityType: 'DIVIDEND', tax: 2.15, fee: 0.22, amount: 5.43 });
  });
});

describe('cash rows: more shapes', () => {
  it('imports an iDEAL deposit once under both the old and the new name', () => {
    const acts = run(
      row({ desc: 'iDEAL storting', amt: '100,00' }),
      row({ date: '16-03-2025', desc: 'Reservation iDEAL', amt: '50,00' }),
      row({ date: '17-03-2025', desc: 'Reservation iDEAL', amt: '-50,00' }),
      row({ date: '17-03-2025', desc: 'iDEAL Deposit', amt: '50,00' }),
    );
    expect(acts.map(a => [a.activityType, a.amount])).toEqual([['DEPOSIT', 100], ['DEPOSIT', 50]]);
  });

  it('skips a withdrawal reversal pair but imports a real withdrawal', () => {
    const acts = run(
      row({ desc: 'Processed Flatex Withdrawal', amt: '200,00' }),
      row({ desc: 'flatex terugstorting', amt: '-200,00' }),
      row({ date: '20-03-2025', desc: 'Processed Flatex Withdrawal', amt: '-300,00' }),
    );
    expect(acts.map(a => [a.activityType, a.amount])).toEqual([['WITHDRAWAL', 300]]);
  });

  it('imports one FEE per exchange connection fee at the same timestamp', () => {
    const acts = run(
      row({ desc: 'DEGIRO Aansluitingskosten 2025 (Nasdaq - NDQ)', amt: '-2,50' }),
      row({ desc: 'DEGIRO Aansluitingskosten 2025 (New York Stock Exchange - NSY)', amt: '-2,50' }),
    );
    expect(acts.map(a => a.activityType)).toEqual(['FEE', 'FEE']);
  });

  it('skips money market fund value changes and conversions', () => {
    const acts = run(
      row({ product: 'MS FUND,LU1959429272', desc: 'Koersverandering geldmarktfonds (EUR)', amt: '0,00' }),
      row({ product: 'MS FUND,LU1959429272', desc: 'Conversie geldmarktfonds: Koop 5 @ 100 EUR', amt: '' }),
      row({ product: 'MS FUND,LU1959429272', desc: 'Degiro Cash Sweep Transfer', amt: '-3,00' }),
    );
    expect(acts).toHaveLength(0);
  });

  it('skips ISIN and product changes (cash-neutral; holdings handling is tracked in #20)', () => {
    const acts = run(
      row({ product: 'OLD CO,US0000000001', desc: 'WIJZIGING ISIN: Koop 10 @ 5 USD', ccy: 'USD', amt: '-50,00' }),
      row({ product: 'OLD CO,US0000000002', desc: 'WIJZIGING ISIN: Verkoop 10 @ 5 USD', ccy: 'USD', amt: '50,00' }),
    );
    expect(acts).toHaveLength(0);
  });

  // (#23)
  it.fails('treats "Rente" as interest', () => {
    const acts = run(row({ desc: 'Rente', amt: '-0,15' }));
    expect(acts.map(a => a.activityType)).toEqual(['INTEREST']);
  });

  // (#24)
  it.fails('skips a row with an unparsable date instead of throwing', () => {
    expect(() => run(row({ date: '2025-11-14', desc: 'iDEAL storting', amt: '10,00' }))).not.toThrow();
  });
});

describe('known gaps', () => {
  // (#13) ~245 conversion pairs in a real export; needs a design decision first
  it.todo('imports standalone currency conversions (pair by currency/sign and timestamp, not by description)');
  it.todo('imports trade-linked currency conversions (one pair per fill, sharing the Order Id)');
  // (#20) stock splits arrive as +/- pairs of "SPLIT AANPASSING: N <product> @ N USD (ISIN)"
  it.todo('maps SPLIT AANPASSING pairs to a SPLIT activity (needs the SPLIT semantics from Wealthfolio)');
  // (#22)
  it.todo('attaches a Transactiekosten row without Order Id to the trade with the same ISIN/date/time');
  // (#5 is covered in the dividends block)
});
