import { describe, expect, it } from 'vitest';
import {
  addTokenAlert,
  evaluateTokenPriceAlerts,
  MAX_TOKEN_ALERTS,
  removeTokenAlert,
  TOKEN_ALERTS_STORAGE_KEY,
  TokenAlertsError,
  tokenPriceAlertTriggered,
} from './token-alerts';

function memoryStorage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[TOKEN_ALERTS_STORAGE_KEY, initial]]);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const marketA = `0x${'1'.repeat(40)}`;
const marketB = `0x${'2'.repeat(40)}`;

describe('browser token price alerts', () => {
  it('compares decimal native/token targets against exact rational price ratios', () => {
    // 0.001 native/token = 10^15 wei / 1
    const ratioBelow = { numerator: '999999999999999', denominator: '1' };
    const ratioExact = { numerator: '3000000000000000', denominator: '3' };
    const ratioAbove = { numerator: '3000000000000003', denominator: '3' };

    expect(tokenPriceAlertTriggered({ direction: 'above', targetNativePerToken: '0.001' }, ratioBelow)).toBe(false);
    expect(tokenPriceAlertTriggered({ direction: 'above', targetNativePerToken: '0.001' }, ratioExact)).toBe(true);
    expect(tokenPriceAlertTriggered({ direction: 'above', targetNativePerToken: '0.001' }, ratioAbove)).toBe(true);

    expect(tokenPriceAlertTriggered({ direction: 'below', targetNativePerToken: '0.001' }, ratioBelow)).toBe(true);
    expect(tokenPriceAlertTriggered({ direction: 'below', targetNativePerToken: '0.001' }, ratioExact)).toBe(true);
    expect(tokenPriceAlertTriggered({ direction: 'below', targetNativePerToken: '0.001' }, ratioAbove)).toBe(false);

    // Extremely small sub-wei price (numerator=1, denominator=10^60) never triggers above, triggers below.
    expect(
      tokenPriceAlertTriggered({ direction: 'above', targetNativePerToken: '0.000000000000000001' }, { numerator: '1', denominator: '100000000000000000000' }),
    ).toBe(false);
    expect(
      tokenPriceAlertTriggered({ direction: 'below', targetNativePerToken: '0.000000000000000001' }, { numerator: '1', denominator: '100000000000000000000' }),
    ).toBe(true);
  });

  it('evaluates only alerts belonging to the selected market', () => {
    const store = memoryStorage();
    addTokenAlert(store, { market: marketA, direction: 'above', targetNativePerToken: '1' });
    const addedB = addTokenAlert(store, { market: marketB, direction: 'above', targetNativePerToken: '0.5' });

    const hitA = evaluateTokenPriceAlerts(addedB.items, marketA.toUpperCase(), { numerator: '2000000000000000000', denominator: '1' });
    expect(hitA).toHaveLength(1);
    expect(hitA[0]!.market).toBe(marketA);
  });

  it('enforces validation, 50-alert capacity, removal, unreadable protection and tab conflicts', () => {
    const store = memoryStorage();
    for (const badTarget of ['0', '-1', '1.1234567890123456789', 'abc']) {
      expect(() => addTokenAlert(store, { market: marketA, direction: 'above', targetNativePerToken: badTarget })).toThrow(TokenAlertsError);
    }
    expect(() => addTokenAlert(store, { market: '0x0000000000000000000000000000000000000000', direction: 'above', targetNativePerToken: '1' })).toThrow(TokenAlertsError);

    for (let i = 0; i < MAX_TOKEN_ALERTS; i += 1) {
      addTokenAlert(store, { market: marketA, direction: 'above', targetNativePerToken: String(i + 1) });
    }
    expect(() => addTokenAlert(store, { market: marketA, direction: 'above', targetNativePerToken: '99' })).toThrow(TokenAlertsError);

    const removed = removeTokenAlert(store, JSON.parse(store.getItem(TOKEN_ALERTS_STORAGE_KEY)!)[0].id);
    expect(removed.items).toHaveLength(MAX_TOKEN_ALERTS - 1);

    const corrupt = memoryStorage('not-json');
    expect(() => addTokenAlert(corrupt, { market: marketA, direction: 'above', targetNativePerToken: '1' })).toThrow(TokenAlertsError);
    expect(corrupt.getItem(TOKEN_ALERTS_STORAGE_KEY)).toBe('not-json');

    let calls = 0;
    const conflicting = {
      getItem: () => (++calls === 1 ? '[]' : '[{"changed":true}]'),
      setItem: () => {
        throw new Error('Should not overwrite');
      },
    };
    expect(() => addTokenAlert(conflicting, { market: marketA, direction: 'above', targetNativePerToken: '1' })).toThrow(TokenAlertsError);
  });
});
