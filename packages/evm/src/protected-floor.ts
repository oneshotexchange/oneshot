import { UINT256_MAX } from './economics';

export type ProtectedFloorPrice = {
  enteredRaw: bigint;
  floorRaw: bigint;
  listingRaw: bigint;
  adjusted: boolean;
};

function amount(value: bigint, field: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${field} must be a bigint amount in native base units.`);
  if (value < 0n || value > UINT256_MAX) throw new RangeError(`${field} is outside uint256.`);
  return value;
}

/** Applies the protected-floor rule to amounts in the same native base units.
 * Eligibility, floor selection and any fiat conversion belong to the caller.
 * A below-floor input is added to the floor; an input at or above it is unchanged.
 */
export function applyProtectedFloor(enteredRaw: bigint, floorRaw: bigint): ProtectedFloorPrice {
  amount(enteredRaw, 'Entered price');
  amount(floorRaw, 'Floor price');
  const adjusted = enteredRaw < floorRaw;
  const listingRaw = adjusted ? floorRaw + enteredRaw : enteredRaw;
  if (listingRaw > UINT256_MAX) throw new RangeError('Protected listing price exceeds uint256.');
  return { enteredRaw, floorRaw, listingRaw, adjusted };
}
