import { describe, expect, it } from 'vitest';
import { serviceMessage } from './service-message';

describe('customer service errors', () => {
  it('keeps operator instructions out of customer messages', () => {
    for (const code of ['INDEXER_CONFIG_INCOMPLETE', 'AUTH_NOT_CONFIGURED', 'AUTH_PROVIDER_UNAVAILABLE', 'DATABASE_REQUIRED', 'DEPLOYMENT_REQUIRED', 'APP_ORIGIN_REQUIRED', 'API_ORIGIN_REQUIRED', 'INVALID_APP_ORIGIN', 'INVALID_API_ORIGIN', 'FLOOR_CONFIG_INVALID', 'LISTING_AUTHORITY_UNAVAILABLE', 'RPC_DATA_INVALID', 'CONTRACT_NOT_DEPLOYED']) {
      expect(serviceMessage(code, 'Configure private-provider and database settings.', 'Failed')).toBe('This service is temporarily unavailable. Please try again later.');
    }
  });
  it('preserves transaction consequences and user validation messages', () => {
    expect(serviceMessage('TRANSACTION_REVERTED', 'This transaction reverted. Review your balance.', 'Failed')).toBe('This transaction reverted. Review your balance.');
    expect(serviceMessage('DRAFT_CHANGED', 'Reload your draft before saving.', 'Failed')).toBe('Reload your draft before saving.');
    expect(serviceMessage(null, null, 'Try again.')).toBe('Try again.');
  });
  it('gives a customer action for missing NFT records and unavailable saved content', () => {
    expect(serviceMessage('INDEXED_RECORD_NOT_FOUND', 'Not present at the indexed checkpoint.', 'Failed')).toBe('This NFT is currently unavailable. Refresh the collection to view available items.');
    expect(serviceMessage('CONTENT_INTEGRITY', 'Stored metadata commitment failed its content check.', 'Failed')).toBe('The saved content could not be verified. Please try again later.');
    expect(serviceMessage('CONTENT_READ_TIMEOUT', 'Stored content could not be read within its deadline.', 'Failed')).toBe('The saved content is taking too long to load. Please try again.');
  });
});
